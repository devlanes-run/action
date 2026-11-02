// Prepares the runner before the daemon starts: user config and the proxy's ports, which the
// daemon reads only when it starts, and on Linux `devlanes setup`.

import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import * as core from '@actions/core';
import { parse } from 'yaml';
import { type Devlanes, parseJson } from './devlanes.ts';
import type { HostsMode } from './inputs.ts';

/**
 * Settings every CI daemon gets. A lane without requests would otherwise be throttled after 5
 * minutes and frozen after 15, such as during a build between `start` and the tests. From
 * devlanes 0.7.0 a daemon that only commands used exits after about 5 idle minutes, which would
 * end the daemon `command: install` started before a later step uses it; the post step stops it.
 * The start gate keeps its adaptive default: it starts at full speed and only backs off when
 * CPU or memory runs short, which on a small runner is what keeps a large start from swapping.
 */
export const ciConfig: [string, string][] = [
  ['lanes.freeze_after', '0s'],
  ['lanes.throttle_after', '0s'],
  ['daemon.exit_when_idle', 'false']
];

/** One `devlanes config set` (or `unset`, for a null value). */
export interface ConfigChange {
  key: string;
  value: string | null;
}

/**
 * `hostnames.hosts_file` for the `hosts-file` input, on Linux only, where devlanes writes
 * /etc/hosts through a helper that `devlanes setup` installs: `always` asks for the helper even
 * when `*.localhost` resolves, and `never` keeps setup from installing it. Elsewhere the action
 * writes the hosts file itself.
 */
export function hostsConfig(platform: NodeJS.Platform, mode: HostsMode): ConfigChange[] {
  if (platform !== 'linux' || mode === 'auto') return [];
  return [{ key: 'hostnames.hosts_file', value: mode === 'true' ? 'always' : 'never' }];
}

/**
 * The `config` input as dotted settings. Mappings become dotted keys; lists and scalars become
 * JSON, which `devlanes config set` reads as YAML: a string stays a string even when it looks
 * like `true`, a number, a `*` alias or a `# comment`, and a value never starts with `-`.
 */
export function flattenConfig(text: string): ConfigChange[] {
  if (!text.trim()) return [];
  const document: unknown = parse(text);
  if (!isMapping(document)) throw new Error('Input "config" must be a YAML mapping');

  const changes: ConfigChange[] = [];
  const visit = (value: unknown, path: string[]) => {
    if (isMapping(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
      return;
    }
    const key = path.join('.');
    changes.push({ key, value: value === null ? null : JSON.stringify(value) });
  };
  visit(document, []);
  return changes;
}

/** Whether a parsed YAML value is a mapping. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Applies config changes, failing on the first one devlanes refuses. */
export async function applyConfig(devlanes: Devlanes, changes: ConfigChange[]): Promise<void> {
  for (const { key, value } of changes) {
    const args = value === null ? ['config', 'unset', key] : ['config', 'set', key, value];
    const result = await devlanes.run(args);
    if (result.code !== 0) {
      throw new Error(
        `devlanes ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`
      );
    }
  }
}

/** Runs a command without a shell and reports whether it exited 0. */
export function succeeds(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Whether `command` is on PATH: it starts at all, whatever it exits with. */
export function exists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, [], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(true));
  });
}

/** Lets unprivileged processes bind 80 and 443 so public URLs carry no port. Linux only. */
export async function allowLowPorts(): Promise<void> {
  if (!(await succeeds('sudo', ['-n', 'true']))) {
    core.warning(
      'low-ports needs passwordless sudo; the devlanes proxy falls back to ports 8443 and 8080'
    );
    return;
  }
  if (
    !(await succeeds('sudo', [
      '-n',
      'sysctl',
      '-q',
      '-w',
      'net.ipv4.ip_unprivileged_port_start=80'
    ]))
  ) {
    core.warning(
      'Could not lower net.ipv4.ip_unprivileged_port_start; the proxy falls back to 8443 and 8080'
    );
  }
}

/**
 * Makes sure `certutil` exists, so `tls.trust: chrome` can reach the NSS store that Chromium
 * reads. Returns false when it is missing and cannot be installed.
 */
export async function ensureCertutil(): Promise<boolean> {
  // certutil prints its usage and exits 1 without arguments, so only a failed spawn means missing.
  if (await exists('certutil')) return true;
  if (!(await succeeds('sudo', ['-n', 'true'])) || !(await succeeds('apt-get', ['--version']))) {
    return false;
  }
  const install = ['-n', 'apt-get', 'install', '-y', '-qq', 'libnss3-tools'];
  if (await succeeds('sudo', install)) return true;
  // Stale package lists on older images make the first install 404.
  await succeeds('sudo', ['-n', 'apt-get', 'update', '-qq']);
  return succeeds('sudo', install);
}

/**
 * Runs `devlanes setup` on Linux, which trusts the CA in the stores of `tls.trust` and installs
 * the /etc/hosts helper when `hostnames.hosts_file` or the runner needs it; problems become
 * warnings. `stores` false keeps a `tls.trust` the workflow set through the `config` input.
 */
export async function setupLinux(devlanes: Devlanes, stores: boolean): Promise<void> {
  // A `tls.trust` from the workflow, such as one with firefox, needs certutil as much as ours.
  const certutil = await ensureCertutil();
  if (stores) {
    await applyConfig(devlanes, [
      { key: 'tls.trust', value: certutil ? '[system, chrome]' : '[system]' }
    ]);
  }
  if (!certutil) {
    core.warning(
      'certutil is missing and could not be installed; browsers on this runner will not trust the devlanes CA'
    );
  }

  // Without a terminal, setup refuses to act unless --yes answers its question.
  const args = ['setup', '--yes'];
  const result = await devlanes.run(args, { stream: true });
  if (result.code !== 0) core.warning(`devlanes ${args.join(' ')} exited ${result.code}`);
}

/** The warning for runners where the OS store cannot be changed without a person. */
export function trustSkippedWarning(platform: NodeJS.Platform): string {
  const os = platform === 'darwin' ? 'macOS' : 'Windows';
  return `Skipped devlanes setup: ${os} asks for confirmation in a dialog, which a runner cannot answer. Node, Deno, Python and OpenSSL-based tools still trust the CA through export-ca; browsers and curl do not. Set trust: false to hide this warning.`;
}

/** `devlanes daemon status --json`, which also names the devlanes home in use. */
export interface DaemonStatus {
  running: boolean;
  home: string | null;
}

/**
 * The daemon's state. The command exits 1 when no daemon runs and then names the home; a
 * running daemon names its config file in the home instead.
 */
export async function daemonStatus(devlanes: Devlanes): Promise<DaemonStatus> {
  const result = await devlanes.run(['daemon', 'status', '--json']);
  const status = parseJson<{ running?: boolean; home?: string; user_config?: { path?: string } }>(
    result.stdout,
    ['daemon', 'status']
  );
  const config = status.user_config?.path;
  return {
    running: status.running === true,
    home: status.home ?? (config ? dirname(config) : null)
  };
}
