// The action's main step: install devlanes, prepare the runner once per job, then start a lane,
// run a command against it, or stop it.

import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as core from '@actions/core';
import { caFiles, caVariables } from './ca.ts';
import { resolveVersion, versionMessage } from './detect.ts';
import { cli, type Devlanes } from './devlanes.ts';
import { childEnv } from './env.ts';
import { addHosts, hostsPath, laneHostnames, resolvesToLoopback } from './hosts.ts';
import { type Inputs, readInputs } from './inputs.ts';
import { install } from './install.ts';
import { jobFailed } from './job.ts';
import { artifactName, laneLogsDir, shouldUpload, uploadLogs, writeDiagnostics } from './logs.ts';
import {
  failedUnits,
  type HostsPage,
  httpsPort,
  infraOutputs,
  type LaneEnv,
  type LaneSummary,
  type StatusPage,
  serviceOutputs,
  urlOutputs
} from './outputs.ts';
import {
  allowLowPorts,
  applyConfig,
  ciConfig,
  daemonStatus,
  flattenConfig,
  trustLinux,
  trustSkippedWarning
} from './setup.ts';
import { writeScript } from './shell.ts';
import { readyVariable, type State, saveState, stoppedLanes, stoppedVariable } from './state.ts';

/** Runs the main step. */
async function main(): Promise<void> {
  const inputs = readInputs((name) => core.getInput(name), process.platform);
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const cwd = resolve(workspace, inputs.workingDirectory);

  const resolved = resolveVersion(inputs.version, {
    start: cwd,
    workspace,
    exists: existsSync,
    readFile: (path) => readFileSync(path, 'utf8'),
    warn: (text) => core.warning(text)
  });
  core.info(versionMessage(resolved));
  core.setOutput('version-source', resolved.source);
  const installed = await core.group(`Install devlanes ${resolved.version}`, () =>
    install(resolved.version)
  );

  // devlanes reads DEVLANES_HOME relative to each process's directory, and the action runs
  // devlanes from more than one, so a relative input is made absolute once here.
  const home = inputs.home ? resolve(workspace, inputs.home) : '';
  // Later `run: devlanes ...` steps must reach the same daemon, which is keyed by the home.
  if (home) core.exportVariable('DEVLANES_HOME', home);
  const devlanes = () => cli(installed.bin, childEnv(process.env, home));

  const printed = (await devlanes().run(['--version'])).stdout.trim();
  core.setOutput('version', printed.replace(/^devlanes\s+/, '') || installed.version);

  if (inputs.command === 'stop') {
    await stop(devlanes(), inputs, cwd);
    return;
  }

  const daemonStarted = await prepare(devlanes(), inputs);
  // Saved before anything else can fail, so the post step always stops a daemon started here.
  const state: State = {
    bin: installed.bin,
    home: home || process.env.DEVLANES_HOME || join(homedir(), '.devlanes'),
    cwd,
    logsDir: '',
    lane: '',
    daemonStarted,
    hostsLane: '',
    withDone: false,
    failed: false
  };
  saveState(state);

  state.home = (await daemonStatus(devlanes())).home ?? state.home;
  saveState(state);
  core.setOutput('home', state.home);

  // The lane exists before it starts, so its CA, logs folder and hostnames are known up front.
  const laneEnv = inputs.command === 'install' ? null : await currentLane(devlanes(), cwd);

  // The lane names the CA files, which differ from the home's with `tls.ca: mkcert`.
  const fallback = caFiles(state.home);
  const ca = {
    cert: laneEnv?.env.DEVLANES_CA_CERT ?? fallback.cert,
    bundle: laneEnv?.env.DEVLANES_CA_BUNDLE ?? fallback.bundle
  };
  core.setOutput('ca-cert', ca.cert);
  core.setOutput('ca-bundle', ca.bundle);
  if (inputs.exportCa) {
    const dir = join(process.env.RUNNER_TEMP ?? tmpdir(), 'devlanes-ca');
    for (const [name, value] of Object.entries(await caVariables(ca, process.env, dir))) {
      core.exportVariable(name, value);
    }
  }
  if (inputs.command === 'install') return;

  if (laneEnv) {
    state.lane = laneEnv.lane;
    core.setOutput('lane', laneEnv.lane);
    // A lane started again after a `command: stop` needs its post step back.
    const stopped = stoppedLanes(process.env);
    if (stopped.includes(laneEnv.lane)) {
      const rest = stopped.filter((lane) => lane !== laneEnv.lane);
      core.exportVariable(stoppedVariable, rest.join('\n'));
    }
  }
  state.logsDir = laneLogsDir(process.env, state.lane);
  core.setOutput('logs-dir', state.logsDir);
  saveState(state);

  if (state.lane) await laneHosts(devlanes(), inputs, state, cwd);

  if (inputs.command === 'start') await start(devlanes(), inputs, state);
  else await withCommand(devlanes(), inputs, state);
}

/**
 * Configures the runner and starts the daemon, once per job. Returns whether this step started
 * the daemon, which makes its post step the one that stops it.
 */
async function prepare(devlanes: Devlanes, inputs: Inputs): Promise<boolean> {
  const before = await daemonStatus(devlanes);
  if (process.env[readyVariable] && before.running) {
    core.info(
      'devlanes is already set up in this job; config, trust, low-ports and, on Linux, hosts-file: true apply only to the first use of the action'
    );
    return false;
  }
  if (before.running) {
    core.warning(
      'A devlanes daemon was already running; config, low-ports and trust apply after `devlanes daemon restart`'
    );
  }

  const daemonStarted = await core.group('Set up devlanes', async () => {
    const own = flattenConfig(inputs.config);
    // The workflow's settings go last, so they win over the action's.
    await applyConfig(
      devlanes,
      ciConfig.map(([key, value]) => ({ key, value }))
    );
    await applyConfig(devlanes, own);

    const helper = inputs.hostsFile === 'true';
    if (process.platform === 'linux') {
      if (inputs.lowPorts) await allowLowPorts();
      const stores = !own.some((change) => change.key === 'tls.trust');
      if (inputs.trust || helper) await trustLinux(devlanes, helper, stores);
    } else if (inputs.trust) {
      core.warning(trustSkippedWarning(process.platform));
    }

    if (before.running) return false;
    const result = await devlanes.run(['daemon', 'start'], { stream: true });
    if (result.code !== 0) throw new Error(`devlanes daemon start exited ${result.code}`);
    return true;
  });

  // After the daemon starts, so it reports the proxy's ports and the hostname lookup it tried.
  await core.group('devlanes doctor', async () => {
    await devlanes.run(['doctor'], { stream: true });
  });
  core.exportVariable(readyVariable, '1');
  return daemonStarted;
}

/**
 * Adds the lane's hostnames to the hosts file on Windows and macOS when they do not resolve,
 * before anything calls them, and records it so the post step removes them.
 */
async function laneHosts(
  devlanes: Devlanes,
  inputs: Inputs,
  state: State,
  cwd: string
): Promise<void> {
  const platform = process.platform;
  if (platform === 'linux' || inputs.hostsFile === 'false') return;
  const hosts = laneHostnames(await laneStatus(devlanes, state.lane, cwd));
  if (hosts.length === 0) return;
  if (inputs.hostsFile === 'auto' && (await resolvesToLoopback(hosts[0] ?? ''))) return;

  // Recorded first: a write that fails halfway may still have changed the file, and removing a
  // block that is not there does nothing.
  state.hostsLane = state.lane;
  saveState(state);
  try {
    await addHosts(platform, hostsPath(platform, process.env), state.lane, hosts);
    core.info(`Added ${hosts.join(', ')} to the hosts file`);
  } catch (error) {
    core.warning(
      `Could not add the lane's hostnames to the hosts file, which needs an elevated runner on Windows and passwordless sudo on macOS: ${message(error)}`
    );
  }
}

/** `--timeout` and `--profile` flags from the inputs. */
function startFlags(inputs: Inputs): string[] {
  return [
    ...(inputs.timeout ? ['--timeout', inputs.timeout] : []),
    ...inputs.profiles.flatMap((profile) => ['--profile', profile])
  ];
}

/** The lane of the working directory, or null when devlanes cannot name it. */
async function currentLane(devlanes: Devlanes, cwd: string): Promise<LaneEnv | null> {
  try {
    return await devlanes.json<LaneEnv>(['env', 'show'], { cwd });
  } catch (error) {
    core.warning(`Could not read the lane: ${message(error)}`);
    return null;
  }
}

/** The status of one lane, or undefined when devlanes cannot report it. */
async function laneStatus(
  devlanes: Devlanes,
  lane: string,
  cwd: string
): Promise<LaneSummary | undefined> {
  try {
    const page = await devlanes.json<StatusPage>(['status', lane], { cwd });
    return page.items.find((item) => item.reference === lane) ?? page.items[0];
  } catch (error) {
    core.warning(`Could not read the lane's status: ${message(error)}`);
    return undefined;
  }
}

/** `command: start`: start the lane, then publish its URLs, ports and environment. */
async function start(devlanes: Devlanes, inputs: Inputs, state: State): Promise<void> {
  const result = await devlanes.run(['start', '--no-ui', ...startFlags(inputs), ...inputs.units], {
    cwd: state.cwd,
    stream: true
  });

  const laneEnv = await currentLane(devlanes, state.cwd);
  if (laneEnv) {
    core.setOutput('env', JSON.stringify(laneEnv.env));
    if (inputs.exportEnv) {
      for (const [name, value] of Object.entries(laneEnv.env)) core.exportVariable(name, value);
    }
  }
  if (state.lane) {
    const lane = await laneStatus(devlanes, state.lane, state.cwd);
    if (lane) {
      const services = serviceOutputs(lane);
      core.setOutput('lane-index', lane.index === null ? '' : String(lane.index));
      core.setOutput('domain', lane.domain ?? '');
      core.setOutput('services', JSON.stringify(services));
      core.setOutput('urls', JSON.stringify(urlOutputs(services)));
      core.setOutput('infra', JSON.stringify(infraOutputs(lane)));
    }
    try {
      const port = httpsPort(await devlanes.json<HostsPage>(['url', 'ls'], { cwd: state.cwd }));
      core.setOutput('https-port', port === null ? '' : String(port));
    } catch (error) {
      core.warning(`Could not read the proxy's port: ${message(error)}`);
    }
  }

  if (result.code !== 0) {
    state.failed = true;
    saveState(state);
    core.setFailed(`devlanes start exited ${result.code}`);
  }
}

/** `command: with`: start the lane, run the script against it and stop what was started. */
async function withCommand(devlanes: Devlanes, inputs: Inputs, state: State): Promise<void> {
  const argv = await writeScript(
    inputs.shell,
    inputs.run,
    process.env.RUNNER_TEMP ?? tmpdir(),
    process.platform
  );
  const keep = inputs.cleanup === 'keep' ? ['--keep'] : [];
  const result = await devlanes.run(
    [
      'with',
      ...startFlags(inputs),
      ...keep,
      '--logs-dir',
      state.logsDir,
      ...inputs.units,
      '--',
      ...argv
    ],
    { cwd: state.cwd, stream: true }
  );
  core.setOutput('exit-code', String(result.code));
  state.withDone = true;
  if (result.code !== 0) {
    state.failed = true;
    core.setFailed(`devlanes with exited ${result.code}`);
  }
  saveState(state);
}

/** `command: stop`: stop the lane now, write its logs and upload them. */
async function stop(devlanes: Devlanes, inputs: Inputs, cwd: string): Promise<void> {
  const laneEnv = await currentLane(devlanes, cwd);
  if (!laneEnv) throw new Error(`No devlanes lane in ${cwd} to stop`);
  const logsDir = laneLogsDir(process.env, laneEnv.lane);
  core.setOutput('lane', laneEnv.lane);
  core.setOutput('logs-dir', logsDir);

  const lane = await laneStatus(devlanes, laneEnv.lane, cwd);
  const result = await devlanes.run(['stop', '--lane', laneEnv.lane, '--logs-dir', logsDir], {
    cwd,
    stream: true
  });
  let failed = result.code !== 0 || failedUnits(lane).length > 0;
  if (inputs.uploadLogs === 'on-failure' && !failed) {
    failed = await jobFailed(process.env, inputs.token, 'main');
  }

  // Written even without an upload, since `logs-dir` is what a workflow uploads itself.
  await writeDiagnostics(devlanes, logsDir, lane);
  if (shouldUpload(inputs.uploadLogs, failed)) {
    const name = await artifactName(inputs.artifactName, process.env, inputs.token, laneEnv.lane);
    await uploadLogs(logsDir, name, inputs.retentionDays);
  }
  const stopped = [...stoppedLanes(process.env), laneEnv.lane];
  core.exportVariable(stoppedVariable, stopped.join('\n'));
  if (result.code !== 0) core.setFailed(`devlanes stop exited ${result.code}`);
}

/** The text of an error. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => core.setFailed(message(error)));
