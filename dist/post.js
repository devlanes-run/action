import { cli, getInput, shouldUpload, uploadLogs, core_info, logs_artifactName, readInputs, removeHosts, core_warning, jobFailed, stoppedLanes, writeDiagnostics, failedUnits, childEnv, hostsPath, laneLogsDir, loadState } from "./a.js";

// The action's post step, which the runner runs at the end of the job even after a failure or
// a cancellation: stop the lane, upload its logs and stop the daemon this invocation started.
// Problems here are warnings, since the job's result belongs to its own steps.









/** Runs the post step. */ async function post() {
    const state = loadState();
    if (!state) return;
    const inputs = readInputs((name)=>getInput(name), process.platform);
    if (inputs.cleanup === 'keep') {
        core_info('cleanup is keep; leaving the lane and the daemon running and uploading no logs');
        return;
    }
    // The home this invocation used, even when a later use of the action exported another one.
    const devlanes = cli(state.bin, childEnv(process.env, state.home));
    const project = {
        cwd: state.cwd,
        file: inputs.file
    };
    const reference = inputs.command === 'install' ? '' : state.lane || await currentLane(devlanes, project);
    // A later `command: stop` step already stopped this lane and uploaded its logs.
    const stopped = reference !== '' && stoppedLanes(process.env).includes(reference);
    // Empty when the main step failed before it read the lane.
    state.logsDir ||= laneLogsDir(process.env, reference);
    if (reference && !stopped) {
        let failed = state.failed;
        const lane = await attempt('read the lane status', async ()=>{
            const page = await devlanes.json([
                'status',
                reference
            ], project);
            return page.items.find((item)=>item.reference === reference) ?? page.items[0];
        });
        if (failedUnits(lane).length > 0) failed = true;
        // `with` stops what it started and writes its logs, unless it never returned (a cancelled
        // step on Windows ends it at once), which leaves the lane running.
        if (inputs.command === 'start' || !state.withDone) {
            const result = await devlanes.run([
                'stop',
                '--lane',
                reference,
                '--logs-dir',
                state.logsDir
            ], {
                ...project,
                stream: true
            });
            if (result.code !== 0) {
                failed = true;
                core_warning(`devlanes stop exited ${result.code}`);
            }
        }
        // Steps after the action, such as the tests, count too; only the API knows about them.
        if (inputs.uploadLogs === 'on-failure' && !failed) {
            failed = await jobFailed(process.env, inputs.token, 'post');
        }
        if (shouldUpload(inputs.uploadLogs, failed)) {
            await attempt('upload the devlanes logs', async ()=>{
                await writeDiagnostics(devlanes, state.logsDir, lane);
                const name = await logs_artifactName(inputs.artifactName, process.env, inputs.token, reference);
                await uploadLogs(state.logsDir, name, inputs.retentionDays);
            });
        }
    }
    if (inputs.cleanup === 'clean' && reference) {
        await run(devlanes, [
            'lane',
            'clean',
            reference,
            '--yes'
        ], project);
        await run(devlanes, [
            'infra',
            'down',
            '--yes'
        ], project);
    }
    if (state.hostsLane) {
        await attempt('remove the hostnames from the hosts file', ()=>removeHosts(process.platform, hostsPath(process.platform, process.env), state.hostsLane));
    }
    if (state.daemonStarted) await run(devlanes, [
        'daemon',
        'stop',
        '--yes'
    ]);
}
/** Runs a devlanes command into the log, warning when it fails. */ async function run(devlanes, args, project = {}) {
    await attempt(`run devlanes ${args.join(' ')}`, async ()=>{
        const result = await devlanes.run(args, {
            ...project,
            stream: true
        });
        if (result.code !== 0) throw new Error(`it exited ${result.code}`);
    });
}
/** The lane of the project, for a main step that ended before it could save it. */ async function currentLane(devlanes, project) {
    const laneEnv = await attempt('read the lane', ()=>devlanes.json([
            'env',
            'show'
        ], project));
    return laneEnv?.lane ?? '';
}
/** Runs `task`, turning a failure into a warning that says what could not be done. */ async function attempt(what, task) {
    try {
        return await task();
    } catch (error) {
        core_warning(`Could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
post().catch((error)=>core_warning(error instanceof Error ? error.message : String(error)));

export {};
