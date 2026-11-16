// Runs the devlanes CLI. Long commands stream into the job log so the CLI's own log groups and
// annotations reach GitHub; queries capture JSON for outputs.

import { spawn } from 'node:child_process';

/** How a devlanes process ended, with its captured output when it was captured. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Options for one devlanes call. */
export interface RunOptions {
  cwd?: string;
  /** Project file passed as `--file`, relative to `cwd`; empty finds the nearest devlanes.yaml. */
  file?: string;
  /** Stream output to the job log instead of capturing it. */
  stream?: boolean;
}

/** The devlanes CLI as the rest of the action uses it; tests replace it with a fake. */
export interface Devlanes {
  /** Runs `devlanes <args>` and resolves with how it ended, whatever the exit code. */
  run(args: string[], options?: RunOptions): Promise<RunResult>;
  /** Runs `devlanes <args> --json` and returns its last JSON document. */
  json<T>(args: string[], options?: RunOptions): Promise<T>;
}

/** A devlanes CLI at `bin`, run with `env`. */
export function cli(bin: string, env: Record<string, string>): Devlanes {
  return {
    run: (args, options = {}) => spawnProcess(bin, fileArgs(args, options), env, options),
    async json<T>(args: string[], options: RunOptions = {}): Promise<T> {
      const result = await spawnProcess(bin, [...fileArgs(args, options), '--json'], env, {
        ...options,
        stream: false
      });
      // Errors go to stderr as text in every output mode, so JSON on stdout is data even when
      // the exit code is not 0 (`status` exits 1 while a unit has failed).
      if (!result.stdout.trim()) {
        throw new Error(
          `devlanes ${args.join(' ')} exited ${result.code}: ${result.stderr.trim() || 'no output'}`
        );
      }
      return parseJson<T>(result.stdout, args);
    }
  };
}

/**
 * `args` with `--file` in front, where devlanes takes global options, since anything after the
 * `--` of `devlanes with` belongs to the script.
 */
function fileArgs(args: string[], options: RunOptions): string[] {
  return options.file ? ['--file', options.file, ...args] : args;
}

/** The last JSON document in `stdout`, since streaming commands print NDJSON. */
export function parseJson<T>(stdout: string, args: string[]): T {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1);
  if (!last) throw new Error(`devlanes ${args.join(' ')} printed no JSON`);
  try {
    return JSON.parse(last) as T;
  } catch {
    throw new Error(`devlanes ${args.join(' ')} printed something other than JSON: ${last}`);
  }
}

/**
 * Starts `bin` and resolves with its exit status. On Linux and macOS a signal sent to the action
 * (a cancelled job) is passed on, so `devlanes with` can stop what it started before the runner
 * kills it. Windows delivers the runner's Ctrl-C to every process on the console already, and
 * `child.kill` there would end devlanes at once instead.
 */
export function spawnProcess(
  bin: string,
  args: string[],
  env: Record<string, string>,
  options: RunOptions
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env,
      stdio: options.stream ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });

    // A listener also keeps Node from exiting on the signal before devlanes has finished.
    const forward = (signal: NodeJS.Signals) => {
      if (process.platform !== 'win32') child.kill(signal);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    const settle = () => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
    };

    child.on('error', (error) => {
      settle();
      reject(error);
    });
    child.on('close', (code, signal) => {
      settle();
      resolve({ code: code ?? signalCode(signal), stdout, stderr });
    });
  });
}

/** The shell convention 128 + n for a process ended by a signal. */
function signalCode(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGKILL') return 137;
  return 1;
}
