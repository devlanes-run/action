// Finds the devlanes version a project pins when the `version` input is empty, so CI installs
// the one its developers run. Only lockfiles and exact versions count: turning a range into a
// version would need the release list, and could pick another one than the project installs.

import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parseAllDocuments } from 'yaml';
import { compareVersions, defaultVersion, minimumVersion, releasePattern } from './inputs.ts';

/** The version to install and where it came from: `input`, a file's path or `default`. */
export interface Resolved {
  version: string;
  source: string;
}

/** What the search needs from the file system and the log, injected so tests need neither. */
export interface Search {
  /** The folder to start in, usually `working-directory`. */
  start: string;
  /** The last folder searched; nothing above it is read. */
  workspace: string;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  warn: (message: string) => void;
}

/**
 * Reads the devlanes version from a file's contents, or returns null when the file does not name
 * devlanes. `folder` is the start folder relative to the file's, `.` when they are the same.
 * Throws when the file cannot be parsed.
 */
type Reader = (contents: string, folder: string) => string | null;

const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** `value` as an object, or undefined when it is not one. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `folder` and each folder above it up to `.`, nearest first, as `/`-separated paths. */
function ancestors(folder: string): string[] {
  const parts = folder === '.' ? [] : folder.split('/');
  const result: string[] = [];
  for (let length = parts.length; length > 0; length--) {
    result.push(parts.slice(0, length).join('/'));
  }
  result.push('.');
  return result;
}

/**
 * The version in a pnpm v9 `pnpm-lock.yaml`, from the importer of `folder` or the nearest one
 * above it, since Node resolves `devlanes` from parent folders too.
 */
export function pnpmLock(contents: string, folder: string): string | null {
  // pnpm can write the lockfile of its own installation (`packageManagerDependencies`) as a
  // YAML document before the project's, as this repository's pnpm-lock.yaml shows.
  for (const document of parseAllDocuments(contents)) {
    const [error] = document.errors;
    if (error) throw error;
    const importers = record(record(document.toJS())?.importers);
    if (!importers) continue;
    for (const path of ancestors(folder)) {
      const importer = record(importers[path]);
      for (const group of dependencyGroups) {
        const entry = record(importer?.[group])?.devlanes;
        if (entry === undefined) continue;
        // Lockfiles before v6 hold the version itself instead of `{ specifier, version }`.
        const version = typeof entry === 'string' ? entry : record(entry)?.version;
        if (typeof version !== 'string') throw new Error('devlanes has no version');
        // Packages with peer dependencies carry them after the version, as `0.7.2(react@19.0.0)`.
        return version.split('(')[0] ?? '';
      }
    }
  }
  return null;
}

/** The version in an npm v2/v3 `package-lock.json` or `npm-shrinkwrap.json`. */
export function npmLock(contents: string, folder: string): string | null {
  const packages = record(record(JSON.parse(contents))?.packages);
  if (!packages) return null;
  // npm hoists to the root `node_modules`, but keeps a conflicting version in the workspace's own.
  for (const path of ancestors(folder)) {
    const key = path === '.' ? 'node_modules/devlanes' : `${path}/node_modules/devlanes`;
    const entry = packages[key];
    if (entry === undefined) continue;
    const version = record(entry)?.version;
    if (typeof version !== 'string') throw new Error('devlanes has no version');
    return version;
  }
  return null;
}

/**
 * The version in a `yarn.lock`, classic (`devlanes@^0.7.0:` and `version "0.7.2"`) or berry
 * (`"devlanes@npm:^0.7.0":` and `version: 0.7.2`).
 */
export function yarnLock(contents: string): string | null {
  let inBlock = false;
  for (const line of contents.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      if (inBlock) throw new Error('devlanes has no version');
      inBlock = /^"?devlanes@/.test(line);
      continue;
    }
    if (!inBlock) continue;
    // Two spaces: deeper lines belong to the block's dependencies, where one could be `version`.
    const match = /^ {2}version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  if (inBlock) throw new Error('devlanes has no version');
  return null;
}

/** The version in a text `bun.lock`, whose `packages.devlanes[0]` reads `devlanes@X.Y.Z`. */
export function bunLock(contents: string): string | null {
  // bun.lock is JSON with trailing commas, which JSON.parse refuses.
  const json = contents.replace(/,(\s*[}\]])/g, '$1');
  const entry = record(record(JSON.parse(json))?.packages)?.devlanes;
  if (entry === undefined) return null;
  const id = Array.isArray(entry) ? entry[0] : undefined;
  if (typeof id !== 'string' || !id.startsWith('devlanes@')) {
    throw new Error('devlanes has no version');
  }
  return id.slice('devlanes@'.length);
}

/** The version in a `uv.lock` or `poetry.lock`, mapped from PEP 440 to the release's. */
export function pythonLock(contents: string): string | null {
  const packages = parseToml(contents).package;
  if (!Array.isArray(packages)) return null;
  for (const entry of packages) {
    if (record(entry)?.name !== 'devlanes') continue;
    const version = record(entry)?.version;
    if (typeof version !== 'string') throw new Error('devlanes has no version');
    return fromPep440(version);
  }
  return null;
}

/**
 * A PyPI version as the release it was built from, inverting `pep440` in devlanes'
 * packaging/pypi/build.py: `0.8.0rc1` is `0.8.0-rc.1`, and `rc0` is a bare `-rc`.
 * Anything else comes back unchanged and fails the version check.
 */
export function fromPep440(version: string): string {
  const match = /^(\d+\.\d+\.\d+)(?:(a|b|rc)(\d+))?$/.exec(version);
  if (!match) return version;
  const [, release, label, number] = match;
  if (!label) return release ?? version;
  const name = label === 'a' ? 'alpha' : label === 'b' ? 'beta' : 'rc';
  return Number(number) === 0 ? `${release}-${name}` : `${release}-${name}.${Number(number)}`;
}

/** An exact version in a `package.json`'s dependencies; a range returns null. */
export function packageJson(contents: string): string | null {
  const manifest = record(JSON.parse(contents));
  for (const group of dependencyGroups) {
    const value = record(manifest?.[group])?.devlanes;
    if (typeof value !== 'string') continue;
    const match = /^[=v]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(value.trim());
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * The files searched in each folder, in order; the first that names devlanes wins. `bun.lockb`
 * is binary and not read.
 */
const sources: ReadonlyArray<readonly [name: string, read: Reader]> = [
  ['pnpm-lock.yaml', pnpmLock],
  ['package-lock.json', npmLock],
  ['npm-shrinkwrap.json', npmLock],
  ['yarn.lock', yarnLock],
  ['bun.lock', bunLock],
  ['uv.lock', pythonLock],
  ['poetry.lock', pythonLock],
  ['package.json', packageJson]
];

/** `start` and each folder above it up to `workspace`, or only `start` when it is outside. */
export function searchFolders(start: string, workspace: string): string[] {
  const root = resolve(workspace);
  const folders: string[] = [];
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    folders.push(dir);
    const below = relative(root, dir);
    if (!below || below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) break;
  }
  return folders;
}

/** A path as `/`-separated text, the form the log and the `version-source` output use. */
function slashes(path: string): string {
  return path.split(sep).join('/');
}

/**
 * The version pinned by the nearest file that names devlanes, or null when none does. A file
 * that cannot be parsed or names something other than a release is skipped with a warning; a
 * version older than the action supports throws.
 */
export function pinnedVersion(search: Search): Resolved | null {
  const start = resolve(search.start);
  for (const dir of searchFolders(start, search.workspace)) {
    const folder = slashes(relative(dir, start)) || '.';
    for (const [name, read] of sources) {
      const path = join(dir, name);
      if (!search.exists(path)) continue;
      const source = slashes(relative(resolve(search.workspace), path));

      let found: string | null;
      try {
        found = read(search.readFile(path), folder);
      } catch (error) {
        search.warn(`Could not read the devlanes version from ${source}: ${message(error)}`);
        continue;
      }
      if (found === null) continue;

      const version = found.trim().toLowerCase();
      if (!releasePattern.test(version)) {
        search.warn(
          `${source} names devlanes ${found}, which is not a release version; skipping it`
        );
        continue;
      }
      if (compareVersions(version, minimumVersion) < 0) {
        throw new Error(
          `${source} pins devlanes ${version}, which is too old for this action; use ${minimumVersion} or later or set version`
        );
      }
      return { version, source };
    }
  }
  return null;
}

/** The version to install: the input when set, else the one the project pins, else the default. */
export function resolveVersion(input: string, search: Search): Resolved {
  if (input) return { version: input, source: 'input' };
  return pinnedVersion(search) ?? { version: defaultVersion, source: 'default' };
}

/** The log line that says which version is installed and why. */
export function versionMessage(resolved: Resolved): string {
  if (resolved.source === 'input') {
    return `Installing devlanes ${resolved.version} from the version input`;
  }
  if (resolved.source === 'default') {
    return `Installing devlanes ${resolved.version}, the action's default (no lockfile names devlanes)`;
  }
  return `Installing devlanes ${resolved.version} from ${resolved.source}`;
}

/** The text of an error. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
