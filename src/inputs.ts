// Reads the action's inputs once, so the rest of the code works with typed values and every
// mistake in a workflow is reported before anything is installed or started.

export const commands = ['start', 'with', 'stop', 'install'] as const;
export const shells = ['bash', 'sh', 'pwsh', 'powershell', 'cmd'] as const;
export const uploadModes = ['on-failure', 'always', 'never'] as const;
export const cleanupModes = ['stop', 'clean', 'keep'] as const;
export const hostsModes = ['auto', 'true', 'false'] as const;

export type Command = (typeof commands)[number];
export type Shell = (typeof shells)[number];
export type UploadMode = (typeof uploadModes)[number];
export type CleanupMode = (typeof cleanupModes)[number];
export type HostsMode = (typeof hostsModes)[number];

/** The action's inputs after parsing and validation. */
export interface Inputs {
  version: string;
  command: Command;
  run: string;
  shell: Shell;
  profiles: string[];
  units: string[];
  timeout: string;
  workingDirectory: string;
  home: string;
  config: string;
  trust: boolean;
  hostsFile: HostsMode;
  lowPorts: boolean;
  exportEnv: boolean;
  exportCa: boolean;
  uploadLogs: UploadMode;
  artifactName: string;
  retentionDays: number | undefined;
  cleanup: CleanupMode;
  token: string;
}

/** Reads one input by name, as `core.getInput` does. */
export type InputReader = (name: string) => string;

/** Parses every input, throwing an error that names the input when a value is invalid. */
export function readInputs(read: InputReader, platform: NodeJS.Platform): Inputs {
  const command = oneOf(read, 'command', commands, 'start');
  const run = read('run');
  if (command === 'with' && !run.trim()) {
    throw new Error('Input "run" is required when command is "with"');
  }

  return {
    version: version(read('version')),
    command,
    run,
    shell: oneOf(read, 'shell', shells, platform === 'win32' ? 'pwsh' : 'bash'),
    profiles: list(read('profile'), /[,\n]/),
    units: list(read('units'), /\s+/),
    timeout: read('timeout').trim(),
    workingDirectory: read('working-directory').trim() || '.',
    home: read('home').trim(),
    config: read('config'),
    trust: flag(read, 'trust', true),
    hostsFile: oneOf(read, 'hosts-file', hostsModes, 'auto'),
    lowPorts: flag(read, 'low-ports', true),
    exportEnv: flag(read, 'export-env', true),
    exportCa: flag(read, 'export-ca', true),
    uploadLogs: uploadMode(read('upload-logs')),
    artifactName: read('artifact-name').trim(),
    retentionDays: retention(read('retention-days')),
    cleanup: oneOf(read, 'cleanup', cleanupModes, 'stop'),
    token: read('token').trim()
  };
}

/** `upload-logs`, where `true` and `false` mean `always` and `never`. */
function uploadMode(value: string): UploadMode {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'true') return 'always';
  if (trimmed === 'false') return 'never';
  return oneOf(() => trimmed, 'upload-logs', uploadModes, 'on-failure');
}

/**
 * The devlanes version this release of the action was tested with, installed when neither the
 * `version` input nor the project's files name one.
 */
export const defaultVersion = '0.7.0';

/** The oldest devlanes the action supports; its CI runs against nothing older. */
export const minimumVersion = '0.7.0';

/** A bare release version, `X.Y.Z[-pre]`, in lower case. */
export const releasePattern = /^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/;

/**
 * A `version` input normalized to `latest`, `next` or a bare `X.Y.Z[-pre]`. Empty stays empty,
 * which means the version comes from the project's lockfile or the action's default.
 */
export function version(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed === 'latest') return 'latest';
  if (trimmed === 'next') return 'next';

  const bare = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
  if (!releasePattern.test(bare)) {
    throw new Error(
      `Input "version" must be latest, next or a version such as ${defaultVersion}, not "${value}"`
    );
  }
  if (compareVersions(bare, minimumVersion) < 0) {
    throw new Error(`devlanes ${bare} is too old for this action; use ${minimumVersion} or later`);
  }
  return bare;
}

/**
 * Orders two `X.Y.Z[-pre]` versions as semver does: by number, then a prerelease before its
 * release. Prerelease identifiers compare as text, which is enough for `-rc.N`-style tags.
 */
export function compareVersions(a: string, b: string): number {
  const [aCore = '', aPre] = a.split('-', 2);
  const [bCore = '', bPre] = b.split('-', 2);
  const aParts = aCore.split('.').map(Number);
  const bParts = bCore.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (aPre === bPre) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  return aPre < bPre ? -1 : 1;
}

/** Non-empty entries of a list input split by `separator`. */
export function list(value: string, separator: RegExp): string[] {
  return value
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** A choice input, falling back to `fallback` when empty. */
function oneOf<T extends string>(
  read: InputReader,
  name: string,
  choices: readonly T[],
  fallback: T
): T {
  const value = read(name).trim().toLowerCase();
  if (!value) return fallback;
  if ((choices as readonly string[]).includes(value)) return value as T;
  throw new Error(`Input "${name}" must be one of ${choices.join(', ')}, not "${value}"`);
}

/** A boolean input, `true` or `false` in any letter case. */
function flag(read: InputReader, name: string, fallback: boolean): boolean {
  const value = read(name).trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Input "${name}" must be true or false, not "${value}"`);
}

/** `retention-days` as a whole number of days, or undefined to keep the repository default. */
function retention(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const days = Number(trimmed);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error(`Input "retention-days" must be a whole number from 1 to 90, not "${value}"`);
  }
  return days;
}
