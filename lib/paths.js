/**
 * Pure path helpers for the `dsh-project-automemory` bundle.
 *
 * This module deliberately depends only on Node.js builtins: it owns the
 * project-slug layout under `$DSH_HOME/projects`, upward project-root
 * discovery, memory-directory display spelling, and the lexical containment
 * rules that keep every memory path inside one project's memory directory.
 * Keeping these helpers free of plugin-runtime imports makes them unit
 * testable in isolation.
 *
 * @module dsh-project-automemory/paths
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** Directory under the DSH home that holds one directory per project. */
const PROJECTS_DIRECTORY_NAME = 'projects';

/** Identity file inside a project directory that records the project path. */
const PROJECT_IDENTITY_FILE = '.project.json';

/** Matches every character that is not allowed in a project slug. */
const SLUG_UNSAFE_CHARACTERS = /[^A-Za-z0-9_-]/gu;

/**
 * Compute the lowercase SHA-1 hex digest of a string or byte array.
 *
 * Paths.js exposes this tiny helper so `store.js` can re-export it without a
 * circular import; stores use the same digest for snapshots and identities.
 * @param value - UTF-8 string or bytes to digest.
 * @returns 40-character lowercase hex digest.
 */
export function sha1Hex(value) {
	if (typeof value !== 'string' && !(value instanceof Uint8Array)) {
		throw new TypeError('sha1Hex: value must be a string or Uint8Array');
	}
	return createHash('sha1').update(value).digest('hex');
}

/**
 * Whether an fs error means "this name is absent" rather than a real failure.
 * @param error - error thrown by an fs/promises call.
 * @returns true for ENOENT and ENOTDIR.
 */
function isAbsentError(error) {
	return error !== null && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/**
 * Encode an absolute project path as a filesystem-safe slug.
 *
 * Backslashes are normalized to forward slashes, trailing slashes are
 * stripped, and every character outside `[A-Za-z0-9_-]` is replaced by `-`.
 * Repeated dashes are intentionally preserved because collapsing them could
 * make two different paths share one slug.
 * @param absoluteProjectPath - absolute path of the project directory.
 * @returns slug such as `-Users-yang-Work-Project`.
 * @throws TypeError when the argument is not a non-empty string.
 */
export function encodeProjectSlug(absoluteProjectPath) {
	if (typeof absoluteProjectPath !== 'string') {
		throw new TypeError('encodeProjectSlug: project path must be a string');
	}
	if (absoluteProjectPath.trim().length === 0) {
		throw new TypeError('encodeProjectSlug: project path must not be empty');
	}
	const posixPath = absoluteProjectPath.replaceAll('\\', '/');
	// The filesystem root itself normalizes to "/" so it still produces a slug.
	const trimmedPath = posixPath.replace(/\/+$/u, '') || '/';
	return trimmedPath.replace(SLUG_UNSAFE_CHARACTERS, '-');
}

/**
 * Find the nearest ancestor directory (including `cwd`) that contains any of
 * the given marker names.
 *
 * Walking stops at the filesystem root and never leaves it. Only ENOENT and
 * ENOTDIR count as "marker absent"; any other fs error is rethrown so a
 * permission or I/O failure is not silently misread as "no project root".
 * @param cwd - absolute directory to start from.
 * @param markers - marker file or directory names, for example `.git`.
 * @returns the nearest directory containing a marker, or `cwd` when none does.
 * @throws TypeError for a non-absolute `cwd`, a non-array `markers`, or an
 * invalid marker entry.
 */
export async function findProjectRoot(cwd, markers) {
	if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
		throw new TypeError('findProjectRoot: cwd must be an absolute path');
	}
	if (!Array.isArray(markers)) {
		throw new TypeError('findProjectRoot: markers must be an array');
	}
	for (const marker of markers) {
		if (typeof marker !== 'string' || marker.length === 0) {
			throw new TypeError('findProjectRoot: every marker must be a non-empty string');
		}
	}
	const start = resolve(cwd);
	let current = start;
	for (;;) {
		for (const marker of markers) {
			try {
				await stat(join(current, marker));
				return current;
			} catch (error) {
				if (!isAbsentError(error)) throw error;
			}
		}
		const parent = dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

/**
 * Read the identity file of a project directory.
 * @param projectDir - candidate project directory.
 * @returns parsed identity, or undefined when the file is absent or unusable.
 */
async function readProjectIdentity(projectDir) {
	try {
		const raw = await readFile(join(projectDir, PROJECT_IDENTITY_FILE), 'utf8');
		const parsed = JSON.parse(raw);
		if (parsed !== null && typeof parsed === 'object' && typeof parsed.path === 'string') return parsed;
		return undefined;
	} catch (error) {
		if (isAbsentError(error) || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

/**
 * Mark a slug directory as belonging to a project path.
 *
 * Registration is first-writer-wins: an existing identity with a different
 * path means a slug collision and returns false so the caller can retry with a
 * hashed slug. Concurrent creators reconcile through `flag: "wx"` EEXIST and
 * a re-read instead of clobbering each other.
 * @param projectDir - candidate project directory.
 * @param projectPath - absolute project path the directory should identify.
 * @returns true when the directory now identifies `projectPath`.
 */
async function claimProjectDirectory(projectDir, projectPath) {
	try {
		await mkdir(projectDir, { recursive: true });
	} catch (error) {
		// A regular file (or other non-directory) occupies the slug: collide.
		if (error !== null && typeof error === 'object' && (error.code === 'EEXIST' || error.code === 'ENOTDIR')) return false;
		throw error;
	}
	const identity = await readProjectIdentity(projectDir);
	if (identity !== undefined) return identity.path === projectPath;
	const payload = { path: projectPath, createdAt: new Date().toISOString() };
	try {
		await writeFile(
			join(projectDir, PROJECT_IDENTITY_FILE),
			`${JSON.stringify(payload, null, 2)}\n`,
			{ encoding: 'utf8', flag: 'wx' },
		);
		return true;
	} catch (error) {
		if (error === null || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
		// Another process created the identity between read and write: re-read.
		const replayed = await readProjectIdentity(projectDir);
		if (replayed === undefined) return true;
		return replayed.path === projectPath;
	}
}

/**
 * Ensure a project directory exists and carries the identity file, without
 * rewriting an identity that is already present.
 * @param projectDir - destination project directory.
 * @param projectPath - absolute project path to record when absent.
 */
async function ensureProjectIdentity(projectDir, projectPath) {
	await mkdir(projectDir, { recursive: true });
	if ((await readProjectIdentity(projectDir)) !== undefined) return;
	const payload = { path: projectPath, createdAt: new Date().toISOString() };
	try {
		await writeFile(
			join(projectDir, PROJECT_IDENTITY_FILE),
			`${JSON.stringify(payload, null, 2)}\n`,
			{ encoding: 'utf8', flag: 'wx' },
		);
	} catch (error) {
		if (error === null || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
	}
}

/**
 * Resolve the on-disk location of one project's private memory directory.
 *
 * The base directory is `join(dshHome, "projects", encodeProjectSlug(project))`.
 * When that slug is already identified as a different project path (two paths
 * can encode to the same slug), a `sha1(path)[0..8]` suffix is appended, and a
 * full SHA-1 suffix is the final fallback. The project directory is created on
 * demand; the returned `memoryDir` is NOT created here because `store.js` owns
 * memory-directory creation.
 * @param options - resolution inputs.
 * @param options.dshHome - absolute DeepSeek Harness home directory.
 * @param options.projectRoot - absolute project root directory.
 * @returns absolute `{ slug, projectDir, memoryDir, projectFile }` paths.
 * @throws TypeError when `dshHome` or `projectRoot` is invalid.
 */
export async function resolveProjectLocation({ dshHome, projectRoot } = {}) {
	if (typeof dshHome !== 'string' || dshHome.trim().length === 0) {
		throw new TypeError('resolveProjectLocation: dshHome must be a non-empty string');
	}
	if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
		throw new TypeError('resolveProjectLocation: projectRoot must be a non-empty string');
	}
	if (!isAbsolute(projectRoot)) {
		throw new TypeError('resolveProjectLocation: projectRoot must be an absolute path');
	}
	const resolvedDshHome = resolve(dshHome);
	const projectPath = resolve(projectRoot);
	const baseSlug = encodeProjectSlug(projectPath);
	const digest = sha1Hex(projectPath);
	const projectsDir = join(resolvedDshHome, PROJECTS_DIRECTORY_NAME);
	const identityFile = (projectDir) => join(projectDir, PROJECT_IDENTITY_FILE);
	for (const slug of [baseSlug, `${baseSlug}-${digest.slice(0, 8)}`]) {
		const projectDir = join(projectsDir, slug);
		if (!(await claimProjectDirectory(projectDir, projectPath))) continue;
		return {
			slug,
			projectDir,
			memoryDir: join(projectDir, 'memory'),
			projectFile: identityFile(projectDir),
		};
	}
	// The full digest is unique per path, so it is the final fallback.
	const fallbackSlug = `${baseSlug}-${digest}`;
	const fallbackDir = join(projectsDir, fallbackSlug);
	await ensureProjectIdentity(fallbackDir, projectPath);
	return {
		slug: fallbackSlug,
		projectDir: fallbackDir,
		memoryDir: join(fallbackDir, 'memory'),
		projectFile: identityFile(fallbackDir),
	};
}

/**
 * Render the symbolic model-facing spelling of a memory directory.
 * @param homeDisplay - symbolic home display such as `~/.dsh` or `$DSH_HOME`.
 * @param slug - project slug.
 * @returns `${homeDisplay}/projects/${slug}/memory` with POSIX separators.
 */
export function memoryDirectoryDisplay(homeDisplay, slug) {
	if (typeof homeDisplay !== 'string' || typeof slug !== 'string') {
		throw new TypeError('memoryDirectoryDisplay: homeDisplay and slug must be strings');
	}
	const normalizedHome = homeDisplay.replaceAll('\\', '/').replace(/\/+$/u, '');
	return `${normalizedHome}/${PROJECTS_DIRECTORY_NAME}/${slug}/memory`;
}

/**
 * Turn a model-supplied memory path into an absolute filesystem path.
 *
 * Accepted forms mirror the model-facing `memory` tool: omitted, `null`,
 * empty, `/`, `/memories`, and `/memories/` all name the memory directory
 * itself; a leading `/memories/` prefix is optional; a leading `/` means
 * "relative to the memory directory"; backslashes are treated as separators.
 * `..` segments, NUL bytes, and non-strings are rejected, and a final lexical
 * containment check guarantees the result stays inside `memoryDir`.
 * Symlinks are intentionally not resolved: containment here is lexical.
 * @param memoryDir - absolute project memory directory.
 * @param requestedPath - model-supplied path.
 * @returns absolute target path inside `memoryDir`.
 * @throws TypeError or Error with a `memory: ` prefixed message on invalid input.
 */
export function resolveMemoryPath(memoryDir, requestedPath) {
	if (typeof memoryDir !== 'string' || memoryDir.length === 0) {
		throw new TypeError('resolveMemoryPath: memoryDir must be a non-empty string');
	}
	if (requestedPath === undefined || requestedPath === null) return memoryDir;
	if (typeof requestedPath !== 'string') {
		throw new TypeError(`memory: path must be a string, got ${typeof requestedPath}`);
	}
	if (requestedPath.includes('\0')) {
		throw new Error(`memory: path must not contain NUL bytes`);
	}
	const posixPath = requestedPath.replaceAll('\\', '/');
	let relativePath = posixPath;
	if (relativePath.startsWith('/memories/')) relativePath = relativePath.slice('/memories/'.length);
	else if (relativePath === '/memories') relativePath = '';
	relativePath = relativePath.replace(/^\/+/u, '');
	if (relativePath.length === 0) return memoryDir;
	const segments = [];
	for (const segment of relativePath.split('/')) {
		if (segment.length === 0 || segment === '.') continue;
		if (segment === '..') {
			throw new Error(`memory: path "${requestedPath}" must not contain ".." segments`);
		}
		segments.push(segment);
	}
	if (segments.length === 0) return memoryDir;
	const target = join(memoryDir, ...segments);
	const base = memoryDir.endsWith(sep) ? memoryDir.slice(0, -1) : memoryDir;
	if (target !== base && !target.startsWith(`${base}${sep}`)) {
		throw new Error(`memory: path "${requestedPath}" escapes the project memory directory`);
	}
	return target;
}
