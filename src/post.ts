// The action's post step, which the runner runs at the end of the job even after a failure or
// a cancellation: stop the lane, upload its logs and stop the daemon this invocation started.
// Problems here are warnings, since the job's result belongs to its own steps.

import * as core from '@actions/core';
import { cli, type Devlanes, type RunOptions } from './devlanes.ts';
import { childEnv } from './env.ts';
import { hostsPath, removeHosts } from './hosts.ts';
import { readInputs } from './inputs.ts';
import { jobFailed } from './job.ts';
import { artifactName, laneLogsDir, shouldUpload, uploadLogs, writeDiagnostics } from './logs.ts';
import { failedUnits, type LaneEnv, type StatusPage } from './outputs.ts';
import { loadState, stoppedLanes } from './state.ts';

/** Runs the post step. */
async function post(): Promise<void> {
  const state = loadState();
  if (!state) return;
  const inputs = readInputs((name) => core.getInput(name), process.platform);
  if (inputs.cleanup === 'keep') {
    core.info('cleanup is keep; leaving the lane and the daemon running and uploading no logs');
    return;
  }

  // The home this invocation used, even when a later use of the action exported another one.
  const devlanes = cli(state.bin, childEnv(process.env, state.home));
  const project: RunOptions = { cwd: state.cwd, file: inputs.file };
  const reference =
    inputs.command === 'install' ? '' : state.lane || (await currentLane(devlanes, project));
  // A later `command: stop` step already stopped this lane and uploaded its logs.
  const stopped = reference !== '' && stoppedLanes(process.env).includes(reference);
  // Empty when the main step failed before it read the lane.
  state.logsDir ||= laneLogsDir(process.env, reference);

  if (reference && !stopped) {
    let failed = state.failed;
    const lane = await attempt('read the lane status', async () => {
      const page = await devlanes.json<StatusPage>(['status', reference], project);
      return page.items.find((item) => item.reference === reference) ?? page.items[0];
    });
    if (failedUnits(lane).length > 0) failed = true;

    // `with` stops what it started and writes its logs, unless it never returned (a cancelled
    // step on Windows ends it at once), which leaves the lane running.
    if (inputs.command === 'start' || !state.withDone) {
      const result = await devlanes.run(
        ['stop', '--lane', reference, '--logs-dir', state.logsDir],
        { ...project, stream: true }
      );
      if (result.code !== 0) {
        failed = true;
        core.warning(`devlanes stop exited ${result.code}`);
      }
    }

    // Steps after the action, such as the tests, count too; only the API knows about them.
    if (inputs.uploadLogs === 'on-failure' && !failed) {
      failed = await jobFailed(process.env, inputs.token, 'post');
    }
    if (shouldUpload(inputs.uploadLogs, failed)) {
      await attempt('upload the devlanes logs', async () => {
        await writeDiagnostics(devlanes, state.logsDir, lane);
        const name = await artifactName(inputs.artifactName, process.env, inputs.token, reference);
        await uploadLogs(state.logsDir, name, inputs.retentionDays);
      });
    }
  }

  if (inputs.cleanup === 'clean' && reference) {
    await run(devlanes, ['lane', 'clean', reference, '--yes'], project);
    await run(devlanes, ['infra', 'down', '--yes'], project);
  }

  if (state.hostsLane) {
    await attempt('remove the hostnames from the hosts file', () =>
      removeHosts(process.platform, hostsPath(process.platform, process.env), state.hostsLane)
    );
  }

  if (state.daemonStarted) await run(devlanes, ['daemon', 'stop', '--yes']);
}

/** Runs a devlanes command into the log, warning when it fails. */
async function run(devlanes: Devlanes, args: string[], project: RunOptions = {}): Promise<void> {
  await attempt(`run devlanes ${args.join(' ')}`, async () => {
    const result = await devlanes.run(args, { ...project, stream: true });
    if (result.code !== 0) throw new Error(`it exited ${result.code}`);
  });
}

/** The lane of the project, for a main step that ended before it could save it. */
async function currentLane(devlanes: Devlanes, project: RunOptions): Promise<string> {
  const laneEnv = await attempt('read the lane', () =>
    devlanes.json<LaneEnv>(['env', 'show'], project)
  );
  return laneEnv?.lane ?? '';
}

/** Runs `task`, turning a failure into a warning that says what could not be done. */
async function attempt<T>(what: string, task: () => Promise<T>): Promise<T | undefined> {
  try {
    return await task();
  } catch (error) {
    core.warning(`Could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

post().catch((error: unknown) =>
  core.warning(error instanceof Error ? error.message : String(error))
);
