import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  compareVersions,
  defaultVersion,
  list,
  minimumVersion,
  readInputs,
  version
} from './inputs.ts';

/** An input reader over a fixed map, empty for anything missing, as the runner does. */
function reader(values: Record<string, string>) {
  return (name: string) => values[name] ?? '';
}

test('an empty input means the same as the default in action.yml', async () => {
  const metadata = parse(await readFile(new URL('../action.yml', import.meta.url), 'utf8')) as {
    inputs: Record<string, { default?: string }>;
  };
  // The token default is an expression the runner fills in; an empty token is valid on its own.
  const defaults = readInputs(
    (name) => (name === 'token' ? '' : (metadata.inputs[name]?.default ?? '')),
    'linux'
  );
  assert.deepEqual(readInputs(reader({}), 'linux'), defaults);
  assert.match(metadata.inputs.token?.default ?? '', /github\.token/);
  // Empty is what makes the action read the version from the project's lockfile.
  assert.equal(metadata.inputs.version?.default, '');
});

test('upload-logs takes true and false for always and never', () => {
  assert.equal(readInputs(reader({ 'upload-logs': 'true' }), 'linux').uploadLogs, 'always');
  assert.equal(readInputs(reader({ 'upload-logs': 'False' }), 'linux').uploadLogs, 'never');
  assert.throws(() => readInputs(reader({ 'upload-logs': 'yes' }), 'linux'), /"upload-logs"/);
});

test('defaults', () => {
  const inputs = readInputs(reader({}), 'linux');
  assert.equal(inputs.version, '');
  assert.equal(inputs.command, 'start');
  assert.equal(inputs.shell, 'bash');
  assert.equal(inputs.workingDirectory, '.');
  assert.equal(inputs.trust, true);
  assert.equal(inputs.hostsFile, 'auto');
  assert.equal(inputs.token, '');
  assert.equal(inputs.lowPorts, true);
  assert.equal(inputs.exportEnv, true);
  assert.equal(inputs.exportCa, true);
  assert.equal(inputs.uploadLogs, 'on-failure');
  assert.equal(inputs.cleanup, 'stop');
  assert.equal(inputs.retentionDays, undefined);
  assert.deepEqual(inputs.profiles, []);
  assert.deepEqual(inputs.units, []);
});

test('the default shell follows the runner like run steps', () => {
  assert.equal(readInputs(reader({}), 'win32').shell, 'pwsh');
  assert.equal(readInputs(reader({}), 'darwin').shell, 'bash');
});

test('with needs a run script', () => {
  assert.throws(() => readInputs(reader({ command: 'with' }), 'linux'), /"run" is required/);
  const inputs = readInputs(reader({ command: 'with', run: 'pnpm test' }), 'linux');
  assert.equal(inputs.run, 'pnpm test');
});

test('lists split on their separators and drop blanks', () => {
  const inputs = readInputs(
    reader({ profile: 'e2e, ci\nextra', units: ' api  web\n+worker ' }),
    'linux'
  );
  assert.deepEqual(inputs.profiles, ['e2e', 'ci', 'extra']);
  assert.deepEqual(inputs.units, ['api', 'web', '+worker']);
  assert.deepEqual(list(' , ,', /,/), []);
});

test('choices and booleans are case-insensitive and reject anything else', () => {
  const inputs = readInputs(
    reader({ command: 'STOP', trust: 'False', 'upload-logs': 'Always' }),
    'linux'
  );
  assert.equal(inputs.command, 'stop');
  assert.equal(inputs.trust, false);
  assert.equal(inputs.uploadLogs, 'always');
  assert.throws(
    () => readInputs(reader({ command: 'restart' }), 'linux'),
    /"command" must be one of/
  );
  assert.throws(
    () => readInputs(reader({ trust: 'yes' }), 'linux'),
    /"trust" must be true or false/
  );
});

test('retention-days takes whole days from 1 to 90', () => {
  assert.equal(readInputs(reader({ 'retention-days': '7' }), 'linux').retentionDays, 7);
  for (const value of ['0', '91', '1.5', 'week']) {
    assert.throws(() => readInputs(reader({ 'retention-days': value }), 'linux'), /retention-days/);
  }
});

test('versions accept latest, next and exact releases with or without v', () => {
  assert.equal(version(''), '');
  assert.equal(version('  '), '');
  assert.equal(version('Latest'), 'latest');
  assert.equal(version('next'), 'next');
  assert.equal(version('0.7.0'), '0.7.0');
  assert.equal(version('v0.7.2'), '0.7.2');
  assert.equal(version('1.0.0-rc.1'), '1.0.0-rc.1');
  assert.throws(() => version('0.7'), /must be latest, next or a version/);
  assert.throws(() => version('^0.7.0'), /must be latest, next or a version/);
});

test('versions older than the minimum are refused', () => {
  assert.equal(minimumVersion, '0.7.0');
  assert.throws(() => version('0.6.1'), /devlanes 0\.6\.1 is too old for this action; use 0\.7\.0/);
  assert.throws(() => version('0.7.0-rc.1'), /too old/);
  assert.ok(compareVersions(defaultVersion, minimumVersion) >= 0);
});

test('versions order like semver', () => {
  assert.equal(compareVersions('0.7.0', '0.7.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.1'), 1);
});
