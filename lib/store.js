/**
 * Filesystem operations for the `dsh-project-automemory` bundle.
 *
 * The store owns everything that touches the project memory directory:
 * snapshot loading for the system-reminder context, listing and reading
 * entries for the model-facing `memory` tool, and creating, editing, moving,
 * and deleting memory files. It depends only on Node.js builtins plus the
 * dependency-free `paths.js` sibling module.
 *
 * Every user-facing error starts with `memory: ` and names the offending
 * memory-relative path so the model can recover without more context.
 *
 * @module dsh-project-automemory/store
 */

import { lstat, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { resolveMemoryPath, sha1Hex } from './paths.js';

export { sha1Hex };

/** Default memory index file loaded first and treated as the entry point. */
const DEFAULT_INDEX_FILE = 'MEMORY.md';

/** Default maximum bytes read for one memory source file. */
const DEFAULT_MAX_SOURCE_BYTES = 262144;

/** Default maximum characters returned by a single `view` read. */
const DEFAULT_READ_MAX_BYTES = 262144;

/** Matches candidate memory source file names; extensions are case-insensitive. */
const MARKDOWN_SUFFIX = '.md';

/**
 * Whether an fs error means "this name is absent" rather than a real failure.
 * @param error - error thrown by an fs/promises call.
 * @returns true for ENOENT and ENOTDIR.
 */
function isAbsentError(error) {
	return error !== null && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/**
 * Convert an absolute path inside the memory directory into the POSIX
 * memory-relative spelling returned to the model.
 * @param memoryDir - absolute memory directory.
 * @param absolutePath - absolute path inside it.
 * @returns POSIX relative path such as `topic/notes.md`.
 */
function memoryRelativePath(memoryDir, absolutePath) {
	return relative(memoryDir, absolutePath).split(sep).join('/');
}

/**
 * Display spelling for a memory path: `/` for the memory directory itself.
 * @param memoryDir - absolute memory directory.
 * @param absolutePath - absolute path inside it.
 * @returns POSIX relative path, or `/` for the directory root.
 */
function displayMemoryPath(memoryDir, absolutePath) {
	if (absolutePath === memoryDir) return '/';
	return memoryRelativePath(memoryDir, absolutePath);
}

/**
 * Build the standard "path does not exist" error.
 * @param memoryDir - absolute memory directory.
 * @param absolutePath - missing target.
 * @returns Error with a recoverable hint.
 */
function missingPathError(memoryDir, absolutePath) {
	return new Error(
		`memory: "${displayMemoryPath(memoryDir, absolutePath)}" does not exist; use command "view" with path "/" to list files`,
	);
}

/**
 * lstat a path, translating absence into the standard recoverable error.
 * @param memoryDir - absolute memory directory.
 * @param absolutePath - target path.
 * @returns lstat result (symlinks are not followed).
 */
async function lstatOrThrow(memoryDir, absolutePath) {
	try {
		return await lstat(absolutePath);
	} catch (error) {
		if (isAbsentError(error)) throw missingPathError(memoryDir, absolutePath);
		throw error;
	}
}

/**
 * lstat a path, returning undefined when it does not exist.
 * @param absolutePath - target path.
 * @returns lstat result or undefined.
 */
async function lstatOptional(absolutePath) {
	try {
		return await lstat(absolutePath);
	} catch (error) {
		if (isAbsentError(error)) return undefined;
		throw error;
	}
}

/**
 * Assert that a path names an existing regular file and describe it.
 *
 * Symlinks are rejected so an edit can never be redirected outside the
 * project memory directory by a link the model created with another tool.
 * @param memoryDir - absolute memory directory.
 * @param absolutePath - target path.
 * @param verb - operation name used in error messages, such as `edit`.
 * @param pastParticiple - past-tense operation name, such as `edited`.
 * @returns the entry's lstat result.
 */
async function assertExistingRegularFile(memoryDir, absolutePath, verb, pastParticiple = verb) {
	const display = displayMemoryPath(memoryDir, absolutePath);
	const stats = await lstatOrThrow(memoryDir, absolutePath);
	if (stats.isSymbolicLink()) {
		throw new Error(`memory: "${display}" is a symbolic link; refusing to ${verb} it`);
	}
	if (!stats.isFile()) {
		throw new Error(`memory: "${display}" is a directory; only files can be ${pastParticiple}`);
	}
	return stats;
}

/**
 * Read a regular memory file as UTF-8 after symlink and type checks.
 * @param memoryDir - absolute memory directory.
 * @param absolutePath - target file.
 * @param verb - operation name used in error messages.
 * @returns file text.
 */
async function readRegularFileText(memoryDir, absolutePath, verb) {
	await assertExistingRegularFile(memoryDir, absolutePath, verb, verb === 'edit' ? 'edited' : `${verb}ed`);
	return readFile(absolutePath, 'utf8');
}

/**
 * Decode UTF-8 bytes, truncating on a character boundary when over budget.
 * @param bytes - source bytes.
 * @param maxBytes - maximum byte length to decode.
 * @returns UTF-8 text no longer than `maxBytes` bytes.
 */
function decodeCappedUtf8(bytes, maxBytes) {
	if (bytes.length <= maxBytes) return bytes.toString('utf8');
	let end = Math.max(0, Math.trunc(maxBytes));
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end).toString('utf8');
}

/**
 * Assert that a value is a string before writing it to memory.
 * @param value - candidate text.
 * @param label - field name used in the error message.
 */
function assertText(value, label) {
	if (typeof value !== 'string') throw new Error(`memory: ${label} must be a string`);
}

/**
 * Recursively create the project memory directory.
 * @param memoryDir - absolute memory directory.
 */
export async function ensureMemoryDir(memoryDir) {
	if (typeof memoryDir !== 'string' || memoryDir.length === 0) {
		throw new TypeError('ensureMemoryDir: memoryDir must be a non-empty string');
	}
	await mkdir(memoryDir, { recursive: true });
}

/**
 * List top-level auto-load candidates: regular `*.md` files, hidden dotfiles
 * included, with directory and symlink entries skipped.
 * @param memoryDir - absolute memory directory.
 * @returns candidate entries with stat metadata.
 */
async function listSnapshotCandidates(memoryDir) {
	let dirents;
	try {
		dirents = await readdir(memoryDir, { withFileTypes: true });
	} catch (error) {
		if (isAbsentError(error)) return [];
		throw error;
	}
	const candidates = [];
	for (const dirent of dirents) {
		if (!dirent.isFile()) continue;
		if (!dirent.name.toLowerCase().endsWith(MARKDOWN_SUFFIX)) continue;
		let stats;
		try {
			stats = await stat(join(memoryDir, dirent.name));
		} catch (error) {
			if (isAbsentError(error)) continue;
			throw error;
		}
		candidates.push({ name: dirent.name, size: stats.size, mtimeMs: stats.mtimeMs });
	}
	return candidates;
}

/**
 * Load the auto-loaded project memory snapshot.
 *
 * Candidate `.md` files are ordered index-file-first and then alphabetically
 * by UTF-16 code unit. A file longer than `maxSourceBytes` (or unreadable) is
 * skipped from `files` but still participates in the fingerprint, so a
 * content, size, timestamp, or name change always changes the fingerprint.
 * @param options - snapshot options.
 * @param options.memoryDir - absolute project memory directory.
 * @param options.indexFile - index file name loaded first.
 * @param options.maxSourceBytes - largest source file allowed into `files`.
 * @param options.createDirectory - create the memory directory when missing.
 * @returns `{ files, fingerprint, memoryDir }`.
 */
export async function loadMemorySnapshot({
	memoryDir,
	indexFile = DEFAULT_INDEX_FILE,
	maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
	createDirectory = true,
} = {}) {
	if (typeof memoryDir !== 'string' || memoryDir.length === 0) {
		throw new TypeError('loadMemorySnapshot: memoryDir must be a non-empty string');
	}
	if (createDirectory) await ensureMemoryDir(memoryDir);
	const candidates = await listSnapshotCandidates(memoryDir);
	const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
	const orderedNames = [];
	if (byName.has(indexFile)) orderedNames.push(indexFile);
	for (const name of [...byName.keys()].sort()) {
		if (name !== indexFile) orderedNames.push(name);
	}
	const files = [];
	for (const name of orderedNames) {
		const candidate = byName.get(name);
		if (candidate.size > maxSourceBytes) continue;
		try {
			const bytes = await readFile(join(memoryDir, name));
			files.push({ name, content: decodeCappedUtf8(bytes, maxSourceBytes) });
		} catch {
			// An unreadable or vanished source is skipped; the fingerprint keeps it.
		}
	}
	const metadata = candidates
		.slice()
		.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
		.map(({ name, size, mtimeMs }) => [name, size, mtimeMs]);
	const fingerprint = sha1Hex(JSON.stringify([indexFile, metadata]));
	return { files, fingerprint, memoryDir };
}

/**
 * Compute the content digest of a loaded memory snapshot.
 * @param files - ordered `{ name, content }` snapshot entries.
 * @returns SHA-1 hex digest of the name/content pairs.
 */
export function memoryDigest(files) {
	const entries = Array.isArray(files) ? files : [];
	return sha1Hex(JSON.stringify(entries.map(({ name, content }) => [name, content])));
}

/**
 * List one memory directory's immediate entries, sorted by name.
 * @param memoryDir - absolute directory to list.
 * @returns entries shaped `{ name, kind, size?, mtimeMs? }`; symlinks skipped.
 */
export async function listMemoryEntries(memoryDir) {
	if (typeof memoryDir !== 'string' || memoryDir.length === 0) {
		throw new TypeError('listMemoryEntries: memoryDir must be a non-empty string');
	}
	let dirents;
	try {
		dirents = await readdir(memoryDir, { withFileTypes: true });
	} catch (error) {
		if (isAbsentError(error)) throw missingPathError(memoryDir, memoryDir);
		throw error;
	}
	const entries = [];
	for (const dirent of dirents) {
		const absolutePath = join(memoryDir, dirent.name);
		if (dirent.isDirectory()) {
			entries.push({ name: dirent.name, kind: 'directory' });
			continue;
		}
		if (!dirent.isFile()) continue;
		try {
			const stats = await stat(absolutePath);
			entries.push({ name: dirent.name, kind: 'file', size: stats.size, mtimeMs: stats.mtimeMs });
		} catch (error) {
			if (isAbsentError(error)) continue;
			throw error;
		}
	}
	entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	return entries;
}

/**
 * Read one model-requested memory path.
 *
 * Directory targets, including the memory root spelled as `/` or `/memories`,
 * return an immediate entry listing; file targets return UTF-8 text capped at
 * `maxBytes` characters with a `truncated` flag.
 * @param memoryDir - absolute project memory directory.
 * @param requestedPath - model-supplied path.
 * @param options - read options.
 * @param options.maxBytes - maximum characters returned for a file.
 * @returns `{ kind: "directory", entries }` or `{ kind: "file", path, content, truncated }`.
 */
export async function readMemoryEntry(memoryDir, requestedPath, { maxBytes = DEFAULT_READ_MAX_BYTES } = {}) {
	const target = resolveMemoryPath(memoryDir, requestedPath);
	const display = displayMemoryPath(memoryDir, target);
	const stats = await lstatOrThrow(memoryDir, target);
	if (stats.isSymbolicLink()) {
		throw new Error(`memory: "${display}" is a symbolic link; refusing to read it`);
	}
	if (stats.isDirectory()) {
		return { kind: 'directory', entries: await listMemoryEntries(target) };
	}
	if (!stats.isFile()) {
		throw new Error(`memory: "${display}" is not a regular file; only files can be read`);
	}
	const content = await readFile(target, 'utf8');
	const limit = Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes : DEFAULT_READ_MAX_BYTES;
	const truncated = content.length > limit;
	return {
		kind: 'file',
		path: display,
		content: truncated ? content.slice(0, limit) : content,
		truncated,
	};
}

/**
 * Create a new memory file, refusing to overwrite an existing path.
 * @param memoryDir - absolute project memory directory.
 * @param requestedPath - model-supplied path for the new file.
 * @param fileText - exact UTF-8 content; an empty string creates an empty file.
 * @returns `{ path }` with the POSIX memory-relative path.
 */
export async function createMemoryFile(memoryDir, requestedPath, fileText) {
	const target = resolveMemoryPath(memoryDir, requestedPath);
	const display = displayMemoryPath(memoryDir, target);
	if (target === memoryDir) {
		throw new Error('memory: path must name a file inside the project memory directory, not the memory directory itself');
	}
	assertText(fileText, 'file content');
	await mkdir(dirname(target), { recursive: true });
	try {
		await writeFile(target, fileText, { encoding: 'utf8', flag: 'wx' });
	} catch (error) {
		if (error !== null && typeof error === 'object' && (error.code === 'EEXIST' || error.code === 'EISDIR')) {
			throw new Error(`memory: file "${display}" already exists; use command "str_replace" or "insert"`);
		}
		throw error;
	}
	return { path: memoryRelativePath(memoryDir, target) };
}

/**
 * Replace the single occurrence of `oldStr` in an existing memory file.
 * @param memoryDir - absolute project memory directory.
 * @param requestedPath - model-supplied path to an existing file.
 * @param oldStr - exact non-empty text that must occur exactly once.
 * @param newStr - replacement text.
 * @returns `{ path, replacements: 1 }`.
 */
export async function replaceInMemoryFile(memoryDir, requestedPath, oldStr, newStr) {
	const target = resolveMemoryPath(memoryDir, requestedPath);
	const display = displayMemoryPath(memoryDir, target);
	if (target === memoryDir) {
		throw new Error('memory: path must name a file inside the project memory directory, not the memory directory itself');
	}
	assertText(oldStr, 'old_str');
	assertText(newStr, 'new_str');
	if (oldStr.length === 0) throw new Error('memory: old_str must not be empty');
	const content = await readRegularFileText(memoryDir, target, 'edit');
	let count = 0;
	let searchFrom = 0;
	for (;;) {
		const found = content.indexOf(oldStr, searchFrom);
		if (found === -1) break;
		count += 1;
		searchFrom = found + oldStr.length;
	}
	if (count === 0) throw new Error(`memory: old_str was not found in "${display}"`);
	if (count > 1) {
		throw new Error(
			`memory: old_str occurs ${count} times in "${display}"; include more surrounding text so it occurs exactly once`,
		);
	}
	const index = content.indexOf(oldStr);
	const updated = content.slice(0, index) + newStr + content.slice(index + oldStr.length);
	await writeFile(target, updated, 'utf8');
	return { path: display, replacements: 1 };
}

/**
 * Insert complete lines at a 0-based line index of an existing memory file.
 *
 * The index may equal the file's line count to append at the end. A file that
 * ends with a newline keeps its trailing newline because the split preserves
 * the trailing empty line.
 * @param memoryDir - absolute project memory directory.
 * @param requestedPath - model-supplied path to an existing file.
 * @param insertLine - safe integer line index from 0 through the line count.
 * @param insertText - text whose `\n`-separated lines are inserted.
 * @returns `{ path, line }`.
 */
export async function insertInMemoryFile(memoryDir, requestedPath, insertLine, insertText) {
	const target = resolveMemoryPath(memoryDir, requestedPath);
	const display = displayMemoryPath(memoryDir, target);
	if (target === memoryDir) {
		throw new Error('memory: path must name a file inside the project memory directory, not the memory directory itself');
	}
	if (!Number.isSafeInteger(insertLine) || insertLine < 0) {
		throw new Error('memory: insert_line must be a non-negative integer line index');
	}
	assertText(insertText, 'insert_text');
	const content = await readRegularFileText(memoryDir, target, 'edit');
	const lines = content.length === 0 ? [] : content.split('\n');
	const lineCount = content.length === 0 ? 0 : content.endsWith('\n') ? lines.length - 1 : lines.length;
	if (insertLine > lineCount) {
		throw new Error(
			`memory: insert_line ${insertLine} is out of range for "${display}"; valid line indexes are 0 through ${lineCount}`,
		);
	}
	lines.splice(insertLine, 0, ...insertText.split('\n'));
	await writeFile(target, lines.join('\n'), 'utf8');
	return { path: display, line: insertLine };
}

/**
 * Delete an existing memory file.
 * @param memoryDir - absolute project memory directory.
 * @param requestedPath - model-supplied path to an existing file.
 * @returns `{ path }`.
 */
export async function deleteMemoryFile(memoryDir, requestedPath) {
	const target = resolveMemoryPath(memoryDir, requestedPath);
	const display = displayMemoryPath(memoryDir, target);
	if (target === memoryDir) {
		throw new Error('memory: path must name a file inside the project memory directory, not the memory directory itself');
	}
	await assertExistingRegularFile(memoryDir, target, 'delete', 'deleted');
	await unlink(target);
	return { path: display };
}

/**
 * Rename or move a memory file, creating the destination parent directory.
 * @param memoryDir - absolute project memory directory.
 * @param oldPath - model-supplied path of an existing file.
 * @param newPath - model-supplied destination path that must not exist.
 * @returns `{ from, to }` POSIX memory-relative paths.
 */
export async function renameMemoryFile(memoryDir, oldPath, newPath) {
	const from = resolveMemoryPath(memoryDir, oldPath);
	const to = resolveMemoryPath(memoryDir, newPath);
	const fromDisplay = displayMemoryPath(memoryDir, from);
	const toDisplay = displayMemoryPath(memoryDir, to);
	if (from === memoryDir) {
		throw new Error('memory: source path must name a file inside the project memory directory, not the memory directory itself');
	}
	if (to === memoryDir) {
		throw new Error(
			'memory: destination path must name a file inside the project memory directory, not the memory directory itself',
		);
	}
	await assertExistingRegularFile(memoryDir, from, 'rename', 'renamed');
	if ((await lstatOptional(to)) !== undefined) {
		throw new Error(`memory: cannot rename to "${toDisplay}": destination already exists`);
	}
	await mkdir(dirname(to), { recursive: true });
	await rename(from, to);
	return { from: fromDisplay, to: toDisplay };
}
