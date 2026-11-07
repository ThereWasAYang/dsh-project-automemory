/**
 * The model-facing `memory` tool: reads and mutates the calling project's
 * private memory directory.
 *
 * The tool is registered on the Host row and resolves the calling agent's own
 * project on each call, so the same tool instance serves every project a
 * session moves through. It writes through Node's filesystem rather than the
 * sandboxed `write`/`edit` tools because the memory directory is deliberately
 * outside the project workspace.
 *
 * @module dsh-project-automemory/tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { findProjectRoot, memoryDirectoryDisplay, resolveProjectLocation } from './paths.js';
import {
  createMemoryFile,
  deleteMemoryFile,
  ensureMemoryDir,
  insertInMemoryFile,
  readMemoryEntry,
  renameMemoryFile,
  replaceInMemoryFile,
} from './store.js';

/** Command names accepted by the tool. */
const COMMANDS = ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'];

/** Bound on one rendered view result so a huge topic file cannot flood a step. */
const VIEW_MAX_BYTES = 65536;

/**
 * Format a directory view.
 * @param displayPath - user-facing memory directory path.
 * @param entries - directory entries from the memory store.
 * @returns bounded model-facing text.
 */
function renderDirectoryView(displayPath, entries) {
  const header = `Project memory directory: ${displayPath}`;
  if (entries.length === 0) {
    return `${header}\n\nThe directory is empty. Record durable project knowledge with command "create" and path "${'MEMORY.md'}".`;
  }
  const lines = entries.map((entry) => entry.kind === 'directory'
    ? `- ${entry.name}/ (directory)`
    : `- ${entry.name} (${entry.size} bytes)`);
  return [
    header,
    '',
    `Entries (${entries.length}):`,
    ...lines,
    '',
    'Use command "view" with a file path to read a file, "create" to add one, or another write command to update it.',
  ].join('\n');
}

/**
 * Format a file view.
 * @param displayPath - user-facing memory directory path.
 * @param entry - file entry from the memory store.
 * @returns bounded model-facing text.
 */
function renderFileView(displayPath, entry) {
  const header = `Project memory file: ${displayPath}/${entry.path}`;
  const suffix = entry.truncated ? `\n\n[file truncated at ${VIEW_MAX_BYTES} bytes]` : '';
  return `${header}\n\n${entry.content}${suffix}`;
}

/**
 * Build the `memory` tool definition bound to one plugin instance.
 * @param options - plugin context and normalized runtime configuration.
 * @returns a registry-ready tool definition.
 */
export function createMemoryTool({ ctx, config }) {
  return defineTool({
    name: 'memory',
    description: [
      "Read and update this project's persistent memory directory, which lives outside the project directory in a per-project directory owned by DeepSeek Harness.",
      'Memory files are loaded automatically at the start of every conversation in this project. They are private to the project: they are never shared with other projects, and other agents working in the project directory do not see them.',
      'Use memory for durable project knowledge worth keeping across conversations: architecture decisions, conventions, user preferences, useful commands, environment facts, recurring pitfalls, and unfinished context worth resuming.',
      'Keep MEMORY.md as the short index; put growing detail in topic files. Do not store secrets or credentials here, and do not use memory as a substitute for project instruction files.',
    ].join(' '),
    parameters: {
      command: {
        type: 'string',
        required: true,
        enum: COMMANDS,
        description: 'view reads a file or lists the directory; create adds a new file; str_replace replaces text that occurs exactly once; insert inserts text at a line; delete removes a file; rename moves or renames a file.',
      },
      path: {
        type: 'string',
        description: 'File path relative to the project memory directory, for example "MEMORY.md" or "topics/db.md". For view, omit it or use "/" to list every entry.',
      },
      file_text: {
        type: 'string',
        description: 'create: complete content of the new file.',
      },
      old_str: {
        type: 'string',
        description: 'str_replace: exact text to replace. It must occur exactly once in the file; include surrounding context when the text is not unique.',
      },
      new_str: {
        type: 'string',
        description: 'str_replace: replacement text. Omit it or pass an empty string to delete the matched text.',
      },
      insert_line: {
        type: 'integer',
        description: 'insert: 0-based line index before which the text is inserted. 0 inserts at the top; the file line count appends at the end.',
      },
      insert_text: {
        type: 'string',
        description: 'insert: text to insert; it may contain newlines.',
      },
      old_path: {
        type: 'string',
        description: 'rename: existing path relative to the project memory directory.',
      },
      new_path: {
        type: 'string',
        description: 'rename: new path relative to the project memory directory. It must not exist yet.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined || agent.session === undefined) {
        throw new Error('memory: this tool needs a live agent session to resolve the project memory directory');
      }
      const cwd = ctx.workingDirectory.get(agent.session);
      const projectRoot = await findProjectRoot(cwd, config.projectRootMarkers);
      const location = await resolveProjectLocation({ dshHome: config.dshHome, projectRoot });
      const memoryDir = location.memoryDir;
      const displayPath = memoryDirectoryDisplay(config.homeDisplay, location.slug);
      await ensureMemoryDir(memoryDir);
      const targetPath = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path : undefined;
      switch (args.command) {
        case 'view': {
          const entry = await readMemoryEntry(memoryDir, targetPath, { maxBytes: VIEW_MAX_BYTES });
          return entry.kind === 'directory'
            ? renderDirectoryView(displayPath, entry.entries)
            : renderFileView(displayPath, entry);
        }
        case 'create': {
          if (typeof args.file_text !== 'string') throw new Error('memory: command "create" requires file_text');
          if (targetPath === undefined) throw new Error('memory: command "create" requires path');
          const created = await createMemoryFile(memoryDir, targetPath, args.file_text);
          return `Created ${displayPath}/${created.path} (${Buffer.byteLength(args.file_text, 'utf8')} bytes). It is loaded into later conversations in this project.`;
        }
        case 'str_replace': {
          if (targetPath === undefined) throw new Error('memory: command "str_replace" requires path');
          if (typeof args.old_str !== 'string') throw new Error('memory: command "str_replace" requires old_str');
          const newStr = typeof args.new_str === 'string' ? args.new_str : '';
          const updated = await replaceInMemoryFile(memoryDir, targetPath, args.old_str, newStr);
          return `Updated ${displayPath}/${updated.path}: replaced 1 occurrence of old_str.`;
        }
        case 'insert': {
          if (targetPath === undefined) throw new Error('memory: command "insert" requires path');
          if (typeof args.insert_text !== 'string') throw new Error('memory: command "insert" requires insert_text');
          if (!Number.isSafeInteger(args.insert_line) || args.insert_line < 0) {
            throw new Error('memory: command "insert" requires a non-negative integer insert_line');
          }
          const updated = await insertInMemoryFile(memoryDir, targetPath, args.insert_line, args.insert_text);
          return `Updated ${displayPath}/${updated.path}: inserted text at line ${updated.line}.`;
        }
        case 'delete': {
          if (targetPath === undefined) throw new Error('memory: command "delete" requires path');
          const deleted = await deleteMemoryFile(memoryDir, targetPath);
          return `Deleted ${displayPath}/${deleted.path}.`;
        }
        case 'rename': {
          if (typeof args.old_path !== 'string' || typeof args.new_path !== 'string') {
            throw new Error('memory: command "rename" requires old_path and new_path');
          }
          const renamed = await renameMemoryFile(memoryDir, args.old_path, args.new_path);
          return `Renamed ${displayPath}/${renamed.from} to ${displayPath}/${renamed.to}.`;
        }
        default:
          throw new Error(`memory: unknown command "${String(args.command)}"; expected one of ${COMMANDS.join(', ')}`);
      }
    },
  });
}
