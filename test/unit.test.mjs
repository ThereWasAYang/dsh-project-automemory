/**
 * Unit tests for the dependency-free core of `dsh-project-automemory`.
 *
 * Covers slug encoding, project-root discovery, project location collision
 * handling, lexical path containment, snapshot loading, the memory tool's
 * filesystem operations, and the model-facing render budget behavior.
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	encodeProjectSlug,
	findProjectRoot,
	memoryDirectoryDisplay,
	resolveMemoryPath,
	resolveProjectLocation,
	sha1Hex,
} from '../lib/paths.js';
import * as store from '../lib/store.js';
import {
	SYSTEM_REMINDER_CLOSE,
	SYSTEM_REMINDER_OPEN,
	escapeSystemReminder,
	renderMemoryContext,
} from '../lib/render.js';

/**
 * Create a temp directory that is removed after the test.
 * @param context - node:test test context.
 * @returns absolute temp directory path.
 */
async function makeTempDir(context) {
	const directory = await mkdtemp(join(tmpdir(), 'dsh-project-automemory-test-'));
	context.after(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	return directory;
}

/**
 * Create a temp directory that plays the role of a project memory directory.
 * @param context - node:test test context.
 * @returns absolute memory directory path.
 */
async function makeMemoryDir(context) {
	const memoryDir = await makeTempDir(context);
	await store.ensureMemoryDir(memoryDir);
	return memoryDir;
}

/**
 * Read a memory file directly from disk for assertions.
 * @param memoryDir - absolute memory directory.
 * @param name - memory-relative POSIX file name.
 * @returns file text.
 */
async function readMemoryFile(memoryDir, name) {
	return readFile(join(memoryDir, ...name.split('/')), 'utf8');
}

/**
 * Assert that a promise rejects with an error whose message matches.
 * @param promiseFactory - function starting the operation.
 * @param pattern - expected message RegExp.
 */
async function assertMemoryError(promiseFactory, pattern) {
	await assert.rejects(promiseFactory, (error) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, pattern);
		return true;
	});
}

// ---------------------------------------------------------------------------
// lib/paths.js: project slug encoding
// ---------------------------------------------------------------------------

test('encodeProjectSlug maps POSIX, Windows and root paths to safe slugs', () => {
	assert.equal(
		encodeProjectSlug('/Users/yang/Work/DSH_plugin/ProjectMemory'),
		'-Users-yang-Work-DSH_plugin-ProjectMemory',
	);
	assert.equal(encodeProjectSlug('C:\\Users\\x'), 'C--Users-x');
	assert.equal(encodeProjectSlug('/'), '-');
	assert.equal(encodeProjectSlug('/Users/yang/'), '-Users-yang');
	assert.equal(encodeProjectSlug('topic.one/two three'), 'topic-one-two-three');
	// Repeated unsafe runs are preserved rather than collapsed.
	assert.equal(encodeProjectSlug('/a//b'), '-a--b');
});

test('encodeProjectSlug throws TypeError on non-string or blank input', () => {
	assert.throws(() => encodeProjectSlug(42), TypeError);
	assert.throws(() => encodeProjectSlug(null), TypeError);
	assert.throws(() => encodeProjectSlug(''), TypeError);
	assert.throws(() => encodeProjectSlug('   '), TypeError);
});

// ---------------------------------------------------------------------------
// lib/paths.js: project root discovery
// ---------------------------------------------------------------------------

test('findProjectRoot walks up to the nearest marker directory', async (context) => {
	const root = await makeTempDir(context);
	await mkdir(join(root, '.git'));
	const nested = join(root, 'a', 'b', 'c');
	await mkdir(nested, { recursive: true });
	assert.equal(await findProjectRoot(nested, ['.git']), root);
	assert.equal(await findProjectRoot(root, ['.git']), root);

	// A marker can be a regular file, and the nearest ancestor wins over a
	// farther ancestor that also holds a marker.
	const inner = join(root, 'inner-project');
	await mkdir(join(inner, 'src'), { recursive: true });
	await writeFile(join(inner, 'package.json'), '{}');
	assert.equal(await findProjectRoot(join(inner, 'src'), ['package.json', '.git']), inner);
});

test('findProjectRoot returns cwd when no marker exists', async (context) => {
	const root = await makeTempDir(context);
	const nested = join(root, 'x', 'y');
	await mkdir(nested, { recursive: true });
	const absentMarker = `.dsh-memory-absent-marker-${sha1Hex(root).slice(0, 8)}`;
	assert.equal(await findProjectRoot(nested, [absentMarker]), nested);
	assert.equal(await findProjectRoot(nested, []), nested);
});

test('findProjectRoot treats ENOTDIR as absence but rethrows other fs errors', async (context) => {
	const root = await makeTempDir(context);
	const start = join(root, 'x');
	await mkdir(start, { recursive: true });
	await writeFile(join(root, 'file.txt'), 'plain file');
	// root/file.txt/child is ENOTDIR, which means "marker absent"; the walk
	// continues and eventually falls back to the starting directory.
	assert.equal(await findProjectRoot(start, ['file.txt/child']), start);
	// A too-long marker name surfaces ENAMETOOLONG instead of being swallowed.
	await assert.rejects(
		() => findProjectRoot(start, ['x'.repeat(300)]),
		(error) => error.code === 'ENAMETOOLONG',
	);
});

test('findProjectRoot validates its arguments', async () => {
	await assert.rejects(() => findProjectRoot('relative/path', ['.git']), TypeError);
	await assert.rejects(() => findProjectRoot(tmpdir(), 'not-an-array'), TypeError);
	await assert.rejects(() => findProjectRoot(tmpdir(), ['']), TypeError);
	await assert.rejects(() => findProjectRoot(tmpdir(), [42]), TypeError);
});

// ---------------------------------------------------------------------------
// lib/paths.js: project location and display helpers
// ---------------------------------------------------------------------------

test('memoryDirectoryDisplay always produces POSIX display paths', () => {
	assert.equal(memoryDirectoryDisplay('~/.dsh', '-Users-x'), '~/.dsh/projects/-Users-x/memory');
	assert.equal(memoryDirectoryDisplay('$DSH_HOME', 'slug'), '$DSH_HOME/projects/slug/memory');
	assert.equal(memoryDirectoryDisplay('C:\\Users\\x\\.dsh', 'slug'), 'C:/Users/x/.dsh/projects/slug/memory');
});

test('resolveProjectLocation creates the identity file and is stable', async (context) => {
	const dshHome = await makeTempDir(context);
	const workspace = await makeTempDir(context);
	const projectRoot = join(workspace, 'project-alpha');
	await mkdir(projectRoot, { recursive: true });

	const first = await resolveProjectLocation({ dshHome, projectRoot });
	const expectedSlug = encodeProjectSlug(projectRoot);
	assert.equal(first.slug, expectedSlug);
	assert.equal(first.projectDir, join(dshHome, 'projects', expectedSlug));
	assert.equal(first.memoryDir, join(first.projectDir, 'memory'));
	assert.equal(first.projectFile, join(first.projectDir, '.project.json'));
	const identity = JSON.parse(await readFile(first.projectFile, 'utf8'));
	assert.equal(identity.path, projectRoot);
	assert.equal(Number.isNaN(Date.parse(identity.createdAt)), false);

	// resolveProjectLocation owns the project directory but not the memory dir.
	await assert.rejects(() => stat(first.memoryDir), (error) => error.code === 'ENOENT');

	const second = await resolveProjectLocation({ dshHome, projectRoot });
	assert.deepEqual(second, first);
});

test('resolveProjectLocation disambiguates slug collisions with a stable hash suffix', async (context) => {
	const dshHome = await makeTempDir(context);
	const firstPath = '/tmp/a-b/c';
	const secondPath = '/tmp/a/b/c';
	assert.equal(encodeProjectSlug(firstPath), encodeProjectSlug(secondPath));

	const first = await resolveProjectLocation({ dshHome, projectRoot: firstPath });
	const second = await resolveProjectLocation({ dshHome, projectRoot: secondPath });
	assert.notEqual(second.projectDir, first.projectDir);
	assert.equal(second.slug, `${encodeProjectSlug(secondPath)}-${sha1Hex(secondPath).slice(0, 8)}`);
	const secondIdentity = JSON.parse(await readFile(second.projectFile, 'utf8'));
	assert.equal(secondIdentity.path, secondPath);

	// Both resolutions are stable on repeat calls.
	assert.deepEqual(await resolveProjectLocation({ dshHome, projectRoot: secondPath }), second);
	assert.deepEqual(await resolveProjectLocation({ dshHome, projectRoot: firstPath }), first);
});

test('resolveProjectLocation falls back to the full hash when the short suffix collides', async (context) => {
	const dshHome = await makeTempDir(context);
	const projectRoot = '/tmp/a/b/c';
	const baseSlug = encodeProjectSlug(projectRoot);
	const shortSlug = `${baseSlug}-${sha1Hex(projectRoot).slice(0, 8)}`;
	const projectsDir = join(dshHome, 'projects');
	for (const [slug, path] of [
		[baseSlug, '/tmp/a-b/c'],
		[shortSlug, '/tmp/some-other-project'],
	]) {
		await mkdir(join(projectsDir, slug), { recursive: true });
		await writeFile(
			join(projectsDir, slug, '.project.json'),
			JSON.stringify({ path, createdAt: new Date().toISOString() }),
		);
	}
	const location = await resolveProjectLocation({ dshHome, projectRoot });
	assert.equal(location.slug, `${baseSlug}-${sha1Hex(projectRoot)}`);
	assert.equal(location.projectDir, join(projectsDir, `${baseSlug}-${sha1Hex(projectRoot)}`));
	const identity = JSON.parse(await readFile(location.projectFile, 'utf8'));
	assert.equal(identity.path, projectRoot);
});

test('resolveProjectLocation validates its arguments', async (context) => {
	const dshHome = await makeTempDir(context);
	await assert.rejects(() => resolveProjectLocation({ dshHome, projectRoot: 'relative/path' }), TypeError);
	await assert.rejects(() => resolveProjectLocation({ dshHome: '', projectRoot: '/tmp/x' }), TypeError);
});

// ---------------------------------------------------------------------------
// lib/paths.js: memory path containment
// ---------------------------------------------------------------------------

test('resolveMemoryPath accepts file and directory spellings', () => {
	const base = join(tmpdir(), 'dsh-memory-contains-test', 'memory');
	const file = (name) => join(base, ...name.split('/'));
	for (const directorySpelling of [undefined, null, '', '/', '/memories', '/memories/', '/memories\\', '.', './']) {
		assert.equal(resolveMemoryPath(base, directorySpelling), base, `spelling ${JSON.stringify(directorySpelling)}`);
	}
	assert.equal(resolveMemoryPath(base, 'MEMORY.md'), file('MEMORY.md'));
	assert.equal(resolveMemoryPath(base, '/MEMORY.md'), file('MEMORY.md'));
	assert.equal(resolveMemoryPath(base, '/memories/MEMORY.md'), file('MEMORY.md'));
	assert.equal(resolveMemoryPath(base, 'topic/x.md'), file('topic/x.md'));
	assert.equal(resolveMemoryPath(base, 'topic\\x.md'), file('topic/x.md'));
	assert.equal(resolveMemoryPath(base, './topic//x.md'), file('topic/x.md'));
	assert.equal(resolveMemoryPath(base, 'topic/./nested/./x.md'), file('topic/nested/x.md'));
});

test('resolveMemoryPath rejects traversal, NUL bytes and non-strings', () => {
	const base = join(tmpdir(), 'dsh-memory-contains-test', 'memory');
	for (const bad of ['../x', 'a/../../x', '/memories/../x', '..', 'topic/..', '..\\x']) {
		assert.throws(() => resolveMemoryPath(base, bad), /memory: .*\.\./u);
	}
	assert.throws(() => resolveMemoryPath(base, 'a\0b'), /memory: .*NUL/u);
	assert.throws(() => resolveMemoryPath(base, 42), /memory: .*string/u);
	assert.throws(() => resolveMemoryPath(base, {}), /memory: .*string/u);
});

// ---------------------------------------------------------------------------
// lib/store.js: snapshot loading
// ---------------------------------------------------------------------------

test('loadMemorySnapshot loads the index first and then marks files alphabetically', async (context) => {
	const memoryDir = await makeTempDir(context);
	await writeFile(join(memoryDir, 'zzz.md'), 'index body');
	await writeFile(join(memoryDir, 'aaa.md'), 'A');
	await writeFile(join(memoryDir, 'bbb.md'), 'B');
	await writeFile(join(memoryDir, '.hidden.md'), 'hidden');
	await writeFile(join(memoryDir, 'notes.txt'), 'not memory');
	await mkdir(join(memoryDir, 'folder'));
	await writeFile(join(memoryDir, 'folder', 'inner.md'), 'nested');

	const snapshot = await store.loadMemorySnapshot({ memoryDir, indexFile: 'zzz.md' });
	assert.deepEqual(
		snapshot.files.map((file) => file.name),
		['zzz.md', '.hidden.md', 'aaa.md', 'bbb.md'],
	);
	assert.equal(snapshot.files[0].content, 'index body');
	assert.equal(snapshot.memoryDir, memoryDir);
	assert.match(snapshot.fingerprint, /^[0-9a-f]{40}$/u);
});

test('loadMemorySnapshot ignores directories and symlinks', async (context) => {
	const memoryDir = await makeTempDir(context);
	const outside = await makeTempDir(context);
	await writeFile(join(memoryDir, 'MEMORY.md'), 'index');
	await writeFile(join(memoryDir, 'real.md'), 'real');
	await writeFile(join(outside, 'target.md'), 'outside target');
	await symlink(join(outside, 'target.md'), join(memoryDir, 'link.md'));
	await mkdir(join(memoryDir, 'directory.md'));

	const snapshot = await store.loadMemorySnapshot({ memoryDir });
	assert.deepEqual(snapshot.files.map((file) => file.name), ['MEMORY.md', 'real.md']);
});

test('loadMemorySnapshot fingerprint is stable and tracks content and name changes', async (context) => {
	const memoryDir = await makeTempDir(context);
	await writeFile(join(memoryDir, 'MEMORY.md'), 'index');
	await writeFile(join(memoryDir, 'topic.md'), 'topic');

	const first = await store.loadMemorySnapshot({ memoryDir });
	const second = await store.loadMemorySnapshot({ memoryDir });
	assert.equal(second.fingerprint, first.fingerprint);

	const metadata = [];
	for (const name of ['MEMORY.md', 'topic.md']) {
		const stats = await stat(join(memoryDir, name));
		metadata.push([name, stats.size, stats.mtimeMs]);
	}
	metadata.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
	assert.equal(first.fingerprint, sha1Hex(JSON.stringify(['MEMORY.md', metadata])));

	await writeFile(join(memoryDir, 'topic.md'), 'topic changed');
	const afterWrite = await store.loadMemorySnapshot({ memoryDir });
	assert.notEqual(afterWrite.fingerprint, first.fingerprint);

	await rename(join(memoryDir, 'topic.md'), join(memoryDir, 'renamed.md'));
	const afterRename = await store.loadMemorySnapshot({ memoryDir });
	assert.notEqual(afterRename.fingerprint, afterWrite.fingerprint);
});

test('loadMemorySnapshot skips oversized sources but keeps them in the fingerprint', async (context) => {
	const memoryDir = await makeTempDir(context);
	await writeFile(join(memoryDir, 'MEMORY.md'), 'small index');
	await writeFile(join(memoryDir, 'big.md'), 'x'.repeat(200));

	const limited = await store.loadMemorySnapshot({ memoryDir, maxSourceBytes: 64 });
	assert.deepEqual(limited.files.map((file) => file.name), ['MEMORY.md']);
	const full = await store.loadMemorySnapshot({ memoryDir, maxSourceBytes: 1024 });
	assert.deepEqual(full.files.map((file) => file.name), ['MEMORY.md', 'big.md']);
	// Fingerprint metadata is independent of maxSourceBytes.
	assert.equal(limited.fingerprint, full.fingerprint);
});

test('loadMemorySnapshot tolerates a missing memory directory', async (context) => {
	const parent = await makeTempDir(context);
	const memoryDir = join(parent, 'missing-memory');
	const snapshot = await store.loadMemorySnapshot({ memoryDir, createDirectory: false });
	assert.deepEqual(snapshot.files, []);
	assert.equal(snapshot.memoryDir, memoryDir);
	assert.equal(snapshot.fingerprint, sha1Hex(JSON.stringify(['MEMORY.md', []])));
	await assert.rejects(() => stat(memoryDir), (error) => error.code === 'ENOENT');

	// The default creates the directory so later tool calls have a root.
	const created = await store.loadMemorySnapshot({ memoryDir });
	assert.deepEqual(created.files, []);
	assert.equal((await stat(memoryDir)).isDirectory(), true);
});

test('memoryDigest hashes the ordered name/content pairs', () => {
	const files = [
		{ name: 'MEMORY.md', content: 'index' },
		{ name: 'topic.md', content: 'topic' },
	];
	assert.equal(store.memoryDigest(files), sha1Hex(JSON.stringify([['MEMORY.md', 'index'], ['topic.md', 'topic']])));
	assert.notEqual(store.memoryDigest(files), store.memoryDigest(files.slice().reverse()));
	assert.equal(typeof store.sha1Hex, 'function');
	assert.equal(store.sha1Hex('x'), sha1Hex('x'));
});

// ---------------------------------------------------------------------------
// lib/store.js: create / read / list
// ---------------------------------------------------------------------------

test('createMemoryFile and readMemoryEntry round-trip files and directories', async (context) => {
	const memoryDir = await makeMemoryDir(context);
	assert.deepEqual(await store.createMemoryFile(memoryDir, '/memories/MEMORY.md', 'hello world'), {
		path: 'MEMORY.md',
	});
	assert.deepEqual(await store.createMemoryFile(memoryDir, 'topic/notes.md', 'note'), {
		path: 'topic/notes.md',
	});
	assert.deepEqual(await store.createMemoryFile(memoryDir, 'empty.md', ''), { path: 'empty.md' });

	const fileRead = await store.readMemoryEntry(memoryDir, 'MEMORY.md');
	assert.equal(fileRead.kind, 'file');
	assert.equal(fileRead.path, 'MEMORY.md');
	assert.equal(fileRead.content, 'hello world');
	assert.equal(fileRead.truncated, false);
	assert.equal((await store.readMemoryEntry(memoryDir, 'empty.md')).content, '');

	const truncatedRead = await store.readMemoryEntry(memoryDir, '/memories/MEMORY.md', { maxBytes: 5 });
	assert.equal(truncatedRead.content, 'hello');
	assert.equal(truncatedRead.truncated, true);

	const rootView = await store.readMemoryEntry(memoryDir, '/');
	assert.equal(rootView.kind, 'directory');
	assert.deepEqual(rootView.entries.map((entry) => entry.name), ['MEMORY.md', 'empty.md', 'topic']);
	assert.deepEqual(rootView.entries.map((entry) => entry.kind), ['file', 'file', 'directory']);
	const rootFile = rootView.entries.find((entry) => entry.name === 'MEMORY.md');
	assert.equal(rootFile.size, 'hello world'.length);
	assert.equal(typeof rootFile.mtimeMs, 'number');

	const topicView = await store.readMemoryEntry(memoryDir, 'topic');
	assert.equal(topicView.kind, 'directory');
	assert.deepEqual(topicView.entries.map((entry) => [entry.name, entry.kind]), [['notes.md', 'file']]);
	assert.equal(topicView.entries[0].size, 'note'.length);
});

test('createMemoryFile refuses to overwrite and refuses to create the memory root', async (context) => {
	const memoryDir = await makeMemoryDir(context);
	await store.createMemoryFile(memoryDir, 'MEMORY.md', 'original');
	await assertMemoryError(
		() => store.createMemoryFile(memoryDir, 'MEMORY.md', 'again'),
		/^memory: file "MEMORY\.md" already exists; use command "str_replace" or "insert"$/u,
	);
	await assertMemoryError(() => store.createMemoryFile(memoryDir, '/', 'x'), /path must name a file/u);
	await assertMemoryError(() => store.createMemoryFile(memoryDir, '/memories', 'x'), /path must name a file/u);
	await assertMemoryError(() => store.createMemoryFile(memoryDir, '../escape.md', 'x'), /memory: .*\.\./u);
	assert.equal(await readMemoryFile(memoryDir, 'MEMORY.md'), 'original');
});

test('readMemoryEntry reports missing paths with a recoverable hint', async (context) => {
	const memoryDir = await makeMemoryDir(context);
	await assertMemoryError(
		() => store.readMemoryEntry(memoryDir, 'nope.md'),
		/^memory: "nope\.md" does not exist; use command "view" with path "\/" to list files$/u,
	);
	await assertMemoryError(() => store.readMemoryEntry(memoryDir, '../nope.md'), /memory: .*\.\./u);
});

// ---------------------------------------------------------------------------
// lib/store.js: replace
// ---------------------------------------------------------------------------

test('replaceInMemoryFile replaces exactly one unique match', async (context) => {
	const memoryDir = await makeMemoryDir(context);
	await store.createMemoryFile(memoryDir, 'MEMORY.md', 'alpha beta alpha gamma');
	await assertMemoryError(
		() => store.replaceInMemoryFile(memoryDir, 'MEMORY.md', 'alpha', 'A'),
		/old_str occurs 2 times in "MEMORY\.md"; include more surrounding text so it occurs exactly once/u,
	);
	const result = await store.replaceInMemoryFile(memoryDir, 'MEMORY.md', 'beta', 'BETA');
	assert.deepEqual(result, { path: 'MEMORY.md', replacements: 1 });
	assert.equal(await readMemoryFile(memoryDir, 'MEMORY.md'), 'alpha BETA alpha gamma');
});

test('replaceInMemoryFile rejects absent matches, empty oldStr and missing files', async (context) => {
	const memoryDir = await makeMemoryDir(context);
	await store.createMemoryFile(memoryDir, 'MEMORY.md', 'content');
	await assertMemoryError(
		() => store.replaceInMemoryFile(memoryDir, 'MEMORY.md', 'missing', 'x'),
		/^memory: old_str was not found in "MEMORY\.md"$/u,
	);
	await assertMemoryError(
		() => store.replaceInMemoryFile(memoryDir, 'MEMORY.md', '', 'x'),
		/old_str must not be empty/u,
	);
	await assertMemoryError(
		() => store.replaceInMemoryFile(memoryDir, 'ghost.md', 'a', 'b'),
		/does not exist/u,
	);
	await assertMemoryError(() => store.replaceInMemoryFile(memoryDir, '/', 'a', 'b'), /path must name a file/u);
});

// ---------------------------------------------------------------------------
// lib/store.js: insert
// ---------------------------------------------------------------------------

test('insertInMemoryFile inserts at the start, middle and end', async (context) => {
	const memoryDir = await makeMemoryDir(context);
	await store.createMemoryFile(memoryDir, 'x.md', 'a\nb\nc');
	assert.deepEqual(await store.insertInMemoryFile(memoryDir, 'x.md', 0, 'start'), { path: 'x.md', line: 0 });
	assert.equal(await readMemoryFile(memoryDir, 'x.md'), 'start\na\nb\nc');
	assert.deepEqual(await store.insertInMemoryFile(memoryDir, 'x.md', 2, 'mid'), { path: 'x.md', line: 2 });
	assert.equal(await readMemoryFile(memoryDir, 'x.md'), 'start\na\nmid\nb\nc');
	assert.deepEqual(await store.insertInMemoryFile(memoryDir, 'x.md', 5, 'end'), { path: 'x.md', line: 5 });
	assert.equal(await readMemoryFile(memoryDir, 'x.md'), 'start\na\nmid\nb\nc\nend');

	// A trailing newline is preserved when appending at the end.
	await store.createMemoryFile(memoryDir, 'trailing.md', 'a\n');
	await store.insertInMemoryFile(memoryDir, 'trailing.md', 1, 'tail');
	assert.equal(await readMemoryFile(memoryDir, 'trailing.md'), 'a\ntail\n');

	// Multi-line inserts expand in place.
	await store.createMemoryFile(memoryDir, 'multi.md', 'one\ntwo\n');
	await store.insertInMemoryFile(memoryDir, 'multi.md', 1, 'middle-1\nmiddle-2');
	assert.equal(await readMemoryFile(memoryDir, 'multi.md'), 'one\nmiddle-1\nmiddle-2\ntwo\n');
});

test('insertInMemoryFile rejects out-of-range lines and missing files', async (context) => {
	const memoryDir = await makeMemoryDir(context);
	await store.createMemoryFile(memoryDir, 'x.md', 'a\nb');
	for (const invalidLine of [-1, 3, 1.5, '1', Number.NaN]) {
		await assertMemoryError(
			() => store.insertInMemoryFile(memoryDir, 'x.md', invalidLine, 'x'),
			/insert_line/u,
		);
	}
	await assertMemoryError(
		() => store.insertInMemoryFile(memoryDir, 'ghost.md', 0, 'x'),
		/does not exist/u,
	);
	await assertMemoryError(() => store.insertInMemoryFile(memoryDir, '/', 0, 'x'), /path must name a file/u);
});

// ---------------------------------------------------------------------------
// lib/store.js: delete and rename
// ---------------------------------------------------------------------------

test('deleteMemoryFile deletes files and rejects directories and missing paths', async (context) => {
	const memoryDir = await makeMemoryDir(context);
	await store.createMemoryFile(memoryDir, 'topic/x.md', 'x');
	assert.deepEqual(await store.deleteMemoryFile(memoryDir, 'topic/x.md'), { path: 'topic/x.md' });
	await assert.rejects(() => stat(join(memoryDir, 'topic', 'x.md')), (error) => error.code === 'ENOENT');
	await assertMemoryError(() => store.deleteMemoryFile(memoryDir, 'topic/x.md'), /does not exist/u);
	await assertMemoryError(() => store.deleteMemoryFile(memoryDir, '/'), /path must name a file/u);
	await assertMemoryError(
		() => store.deleteMemoryFile(memoryDir, 'topic'),
		/is a directory; only files can be deleted/u,
	);
});

test('renameMemoryFile moves files, creating the destination directory', async (context) => {
	const memoryDir = await makeMemoryDir(context);
	await store.createMemoryFile(memoryDir, 'a.md', 'A');
	await store.createMemoryFile(memoryDir, 'occupied.md', 'B');
	await store.createMemoryFile(memoryDir, 'movable.md', 'M');

	assert.deepEqual(await store.renameMemoryFile(memoryDir, 'a.md', 'topic/a.md'), {
		from: 'a.md',
		to: 'topic/a.md',
	});
	assert.equal(await readMemoryFile(memoryDir, 'topic/a.md'), 'A');
	await assert.rejects(() => stat(join(memoryDir, 'a.md')), (error) => error.code === 'ENOENT');

	await assertMemoryError(
		() => store.renameMemoryFile(memoryDir, 'movable.md', 'occupied.md'),
		/destination already exists/u,
	);
	await assertMemoryError(() => store.renameMemoryFile(memoryDir, 'ghost.md', 'x.md'), /does not exist/u);
	await assertMemoryError(() => store.renameMemoryFile(memoryDir, '/', 'x.md'), /source path must name a file/u);
	await assertMemoryError(() => store.renameMemoryFile(memoryDir, 'movable.md', '/'), /destination path must name a file/u);

	await mkdir(join(memoryDir, 'dir'));
	await store.createMemoryFile(memoryDir, 'dir/inside.md', 'I');
	await assertMemoryError(() => store.renameMemoryFile(memoryDir, 'dir/inside.md', 'dir'), /destination already exists/u);
	await assertMemoryError(() => store.renameMemoryFile(memoryDir, 'dir', 'file.md'), /is a directory; only files can be renamed/u);
});

test('store operations refuse to follow symbolic links out of the memory directory', async (context) => {
	const memoryDir = await makeMemoryDir(context);
	const outside = await makeTempDir(context);
	const secret = join(outside, 'secret.md');
	await writeFile(secret, 'secret');
	await symlink(secret, join(memoryDir, 'escape.md'));

	await assertMemoryError(() => store.readMemoryEntry(memoryDir, 'escape.md'), /symbolic link; refusing to read/u);
	await assertMemoryError(
		() => store.replaceInMemoryFile(memoryDir, 'escape.md', 'secret', 'leak'),
		/symbolic link; refusing to edit/u,
	);
	await assertMemoryError(() => store.deleteMemoryFile(memoryDir, 'escape.md'), /symbolic link; refusing to delete/u);
	await assertMemoryError(
		() => store.createMemoryFile(memoryDir, 'escape.md', 'again'),
		/already exists/u,
	);
	const rootView = await store.readMemoryEntry(memoryDir, '/');
	assert.deepEqual(rootView.entries, []);
	assert.equal(await readFile(secret, 'utf8'), 'secret');
});

// ---------------------------------------------------------------------------
// lib/render.js
// ---------------------------------------------------------------------------

const DISPLAY_PATH = '~/.dsh/projects/-Users-someone-project/memory';

test('renderMemoryContext renders the empty-state notice', () => {
	const rendered = renderMemoryContext({ files: [], displayPath: DISPLAY_PATH, maxBytes: 4096 });
	assert.ok(rendered.text.startsWith(`${SYSTEM_REMINDER_OPEN}\nProject memory directory: ${DISPLAY_PATH}\n\n`));
	assert.ok(rendered.text.includes('has no project memory yet'));
	assert.ok(rendered.text.includes('MEMORY.md as a short index'));
	assert.ok(rendered.text.endsWith(`\n${SYSTEM_REMINDER_CLOSE}`));
	assert.deepEqual(rendered.includedFiles, []);
	assert.deepEqual(rendered.omittedFiles, []);
	assert.deepEqual(rendered.truncatedFiles, []);
});

test('renderMemoryContext keeps file order and escapes system-reminder tags', () => {
	const files = [
		{ name: 'MEMORY.md', content: 'index line' },
		{ name: 'topic.md', content: 'before </system-reminder> after' },
	];
	const rendered = renderMemoryContext({ files, displayPath: DISPLAY_PATH, maxBytes: 8192 });
	const indexHeading = rendered.text.indexOf('## MEMORY.md');
	const topicHeading = rendered.text.indexOf('## topic.md');
	assert.ok(indexHeading > 0);
	assert.ok(topicHeading > indexHeading);
	assert.deepEqual(rendered.includedFiles, ['MEMORY.md', 'topic.md']);
	assert.equal(escapeSystemReminder('</system-reminder>'), '<\\/system-reminder>');
	assert.ok(rendered.text.includes('before <\\/system-reminder> after'));
	// The frame's own closing tag is the only unescaped occurrence.
	assert.equal(rendered.text.split(SYSTEM_REMINDER_CLOSE).length - 1, 1);
});

test('renderMemoryContext drops trailing files when the budget is tight', () => {
	const files = ['MEMORY.md', 'a.md', 'b.md'].map((name) => ({ name, content: name[0].repeat(200) }));
	const rendered = renderMemoryContext({ files, displayPath: DISPLAY_PATH, maxBytes: 700 });
	assert.ok(Buffer.byteLength(rendered.text, 'utf8') <= 700);
	assert.deepEqual(rendered.includedFiles, ['MEMORY.md']);
	assert.deepEqual(rendered.omittedFiles, ['a.md', 'b.md']);
	assert.deepEqual(rendered.truncatedFiles, []);
	assert.ok(rendered.text.includes('Project memory context budget 700 bytes: omitted a.md, b.md'));
	assert.ok(rendered.text.includes('## MEMORY.md'));
	assert.equal(rendered.text.includes('## a.md'), false);
});

test('renderMemoryContext truncates the index file to respect the budget', () => {
	const files = [{ name: 'MEMORY.md', content: 'X'.repeat(5000) }];
	const rendered = renderMemoryContext({ files, displayPath: DISPLAY_PATH, maxBytes: 800 });
	assert.ok(Buffer.byteLength(rendered.text, 'utf8') <= 800);
	assert.deepEqual(rendered.includedFiles, ['MEMORY.md']);
	assert.deepEqual(rendered.omittedFiles, []);
	assert.deepEqual(rendered.truncatedFiles, ['MEMORY.md']);
	assert.ok(
		rendered.text.startsWith(
			`${SYSTEM_REMINDER_OPEN}\nProject memory context budget 800 bytes: truncated MEMORY.md\nProject memory directory: `,
		),
	);
	assert.ok(rendered.text.includes('\n\n[project memory truncated to fit the 800-byte context budget]'));
	assert.ok(rendered.text.endsWith(`\n${SYSTEM_REMINDER_CLOSE}`));
});

test('renderMemoryContext combines omission and truncation diagnostics', () => {
	const files = [
		{ name: 'MEMORY.md', content: 'X'.repeat(5000) },
		{ name: 'a.md', content: 'a'.repeat(100) },
	];
	const rendered = renderMemoryContext({ files, displayPath: DISPLAY_PATH, maxBytes: 900 });
	assert.ok(Buffer.byteLength(rendered.text, 'utf8') <= 900);
	assert.deepEqual(rendered.includedFiles, ['MEMORY.md']);
	assert.deepEqual(rendered.omittedFiles, ['a.md']);
	assert.deepEqual(rendered.truncatedFiles, ['MEMORY.md']);
	const diagnosticIndex = rendered.text.indexOf('Project memory context budget 900 bytes: ');
	const lineEnd = rendered.text.indexOf('\n', diagnosticIndex);
	assert.match(
		rendered.text.slice(diagnosticIndex, lineEnd),
		/omitted a\.md; truncated MEMORY\.md$/u,
	);
});

test('renderMemoryContext uses replacement wording when changed is true', () => {
	const files = [{ name: 'MEMORY.md', content: 'index' }];
	const normal = renderMemoryContext({ files, displayPath: DISPLAY_PATH, maxBytes: 4096 });
	const changed = renderMemoryContext({ files, displayPath: DISPLAY_PATH, maxBytes: 4096, changed: true });
	assert.ok(normal.text.includes("were loaded from this project's private memory directory"));
	assert.equal(changed.text.includes("were loaded from this project's private memory directory"), false);
	assert.ok(changed.text.includes('replaced the previously loaded project memory for this project'));
});

test('renderMemoryContext returns empty text only when the budget is disabled', () => {
	for (const maxBytes of [0, -1, -8000]) {
		const rendered = renderMemoryContext({
			files: [{ name: 'MEMORY.md', content: 'x' }],
			displayPath: DISPLAY_PATH,
			maxBytes,
		});
		assert.deepEqual(rendered, { text: '', includedFiles: [], omittedFiles: [], truncatedFiles: [] });
	}
});

test('renderMemoryContext never exceeds the byte budget and accounts for every file', () => {
	const sizes = [0, 12, 300, 2000];
	const budgets = [1, 200, 500, 2000];
	for (const size of sizes) {
		const files = ['MEMORY.md', 'a.md', 'b.md'].map((name) => ({ name, content: name[0].repeat(size) }));
		for (const maxBytes of budgets) {
			const rendered = renderMemoryContext({ files, displayPath: DISPLAY_PATH, maxBytes });
			const bytes = Buffer.byteLength(rendered.text, 'utf8');
			assert.ok(bytes <= maxBytes, `size=${size} budget=${maxBytes} rendered=${bytes} bytes`);
			assert.ok(rendered.text.length > 0);
			assert.deepEqual(
				[...rendered.includedFiles, ...rendered.omittedFiles],
				files.map((file) => file.name),
				`size=${size} budget=${maxBytes} accounting`,
			);
			for (const name of rendered.truncatedFiles) {
				assert.ok(rendered.includedFiles.includes(name));
			}
		}
	}
});

test('renderMemoryContext truncates the empty-state notice under a tiny budget', () => {
	const rendered = renderMemoryContext({ files: [], displayPath: DISPLAY_PATH, maxBytes: 80 });
	assert.ok(Buffer.byteLength(rendered.text, 'utf8') <= 80);
	assert.ok(rendered.text.length > 0);
	assert.ok(rendered.text.startsWith(SYSTEM_REMINDER_OPEN));
	assert.deepEqual(rendered.includedFiles, []);
});
