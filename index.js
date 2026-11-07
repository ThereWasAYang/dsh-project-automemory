/**
 * Project memory for DeepSeek Harness.
 *
 * Every project gets one private memory directory under the harness home:
 * `$DSH_HOME/projects/<project-slug>/memory`. The first step of every
 * conversation in that project loads the directory's Markdown files into a
 * durable `<system-reminder>` message, and the `memory` tool maintains those
 * files. Memory stays outside the project directory, so project-specific
 * knowledge no longer has to be mixed into the user-global `~/.dsh/AGENTS.md`
 * (which every project reads) or into a project `AGENTS.md` (which every agent
 * working in that checkout reads).
 *
 * The reminder is ordinary sourced `user/message` content: it replays, compacts,
 * and resumes like other history, and a conversation whose memory changed is
 * handed a complete replacement snapshot on the next turn.
 *
 * @module dsh-project-automemory
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { dshHomeDisplay, resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import z from '@deepseek-ai/schemastery';
import { createMemoryTool } from './lib/tool.js';
import { findProjectRoot, memoryDirectoryDisplay, resolveProjectLocation } from './lib/paths.js';
import { renderMemoryContext } from './lib/render.js';
import { loadMemorySnapshot, memoryDigest } from './lib/store.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'project-memory';

/** Services required before the plugin can activate. */
export const inject = ['tools', 'workingDirectory'];

/** Schemastery validation for the row's configuration. */
export const Config = z.object({
  maxBytes: z.number().default(16384),
  maxSourceBytes: z.number().default(262144),
  projectRootMarkers: z.array(z.string()).default(['.git']),
  indexFile: z.string().default('MEMORY.md'),
});

/** Source `kind` of the durable project-memory reminder message. */
const SOURCE_KIND = 'project-memory';

/** Default byte budget for the complete rendered memory context. */
const DEFAULT_MAX_BYTES = 16384;

/** Default cap on one memory source file. */
const DEFAULT_MAX_SOURCE_BYTES = 262144;

/** Default directory names that mark a project root. */
const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'];

/** Default file loaded first from the memory directory. */
const DEFAULT_INDEX_FILE = 'MEMORY.md';

/**
 * Normalize and validate the row configuration, resolve the process harness home.
 * @param rowConfig - raw plugin configuration from the loader row.
 * @returns normalized runtime configuration.
 */
function resolveRuntimeConfig(rowConfig) {
  const maxBytes = rowConfig?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new TypeError('project-memory: maxBytes must be a non-negative finite number');
  }
  const maxSourceBytes = rowConfig?.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  if (!Number.isFinite(maxSourceBytes) || maxSourceBytes <= 0) {
    throw new TypeError('project-memory: maxSourceBytes must be a positive finite number');
  }
  const markers = rowConfig?.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS;
  if (!Array.isArray(markers) || markers.length === 0 || markers.some((marker) => typeof marker !== 'string' || marker.length === 0 || /[\\/]/.test(marker))) {
    throw new TypeError('project-memory: projectRootMarkers must be a non-empty array of directory names');
  }
  const indexFile = rowConfig?.indexFile ?? DEFAULT_INDEX_FILE;
  if (typeof indexFile !== 'string' || indexFile.length === 0 || indexFile === '.' || indexFile === '..' || /[\\/]/.test(indexFile)) {
    throw new TypeError('project-memory: indexFile must be a plain file name inside the memory directory');
  }
  const dshHome = resolveDshHome();
  return {
    maxBytes,
    maxSourceBytes,
    projectRootMarkers: [...markers],
    indexFile,
    dshHome,
    homeDisplay: dshHomeDisplay(dshHome),
  };
}

/**
 * Read the content digest of the newest project-memory message still visible on
 * the session surface. The source records the digest of the memory *content*
 * (not of the rendered text), so re-rendering the same memory in different
 * wording still counts as the same snapshot.
 * @param session - owning session.
 * @returns the durable content digest, or `undefined` when no snapshot is visible.
 */
function visibleMemoryDigest(session) {
  const nodes = session.surface?.nodes;
  if (nodes === undefined || nodes.length === 0) return undefined;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(nodes[index]);
    if (event?.type !== 'user/message') continue;
    const source = event.data.source;
    if (source?.kind === SOURCE_KIND) return typeof source.digest === 'string' ? source.digest : undefined;
  }
  return undefined;
}

/**
 * Per-session loader cache: the last visible snapshot digest plus a fingerprint
 * of the last observed memory directory state.
 * @param states - session-keyed weak cache.
 * @param session - owning session.
 * @returns the mutable state record for that session.
 */
function sessionStateFor(states, session) {
  let state = states.get(session);
  if (state === undefined) {
    state = { digest: undefined, fingerprint: undefined };
    states.set(session, state);
  }
  return state;
}

/**
 * Load the calling project's memory and render the message that should enter
 * the next request, if the conversation is missing a current snapshot.
 * @param ctx - plugin context.
 * @param config - normalized runtime configuration.
 * @param state - per-session loader cache.
 * @param agent - the agent whose step is being prepared.
 * @param signal - the turn's cancellation signal.
 * @returns the durable reminder message, or `undefined` when it is unchanged.
 */
async function composeMemoryMessage(ctx, config, state, agent, signal) {
  const cwd = ctx.workingDirectory.get(agent.session);
  const projectRoot = await findProjectRoot(cwd, config.projectRootMarkers);
  signal?.throwIfAborted();
  const location = await resolveProjectLocation({ dshHome: config.dshHome, projectRoot });
  const displayPath = memoryDirectoryDisplay(config.homeDisplay, location.slug);
  const snapshot = await loadMemorySnapshot({
    memoryDir: location.memoryDir,
    indexFile: config.indexFile,
    maxSourceBytes: config.maxSourceBytes,
  });
  signal?.throwIfAborted();
  if (state.fingerprint === snapshot.fingerprint && state.digest !== undefined) return undefined;
  const digest = memoryDigest(snapshot.files);
  state.fingerprint = snapshot.fingerprint;
  if (digest === state.digest) return undefined;
  const rendered = renderMemoryContext({
    files: snapshot.files,
    displayPath,
    indexFile: config.indexFile,
    maxBytes: config.maxBytes,
    changed: state.digest !== undefined,
  });
  if (rendered.text.length === 0) return undefined;
  state.digest = digest;
  return createUserMessage({
    content: [{ type: 'text', text: rendered.text }],
    source: {
      kind: SOURCE_KIND,
      form: 'snapshot',
      digest,
      memoryDirectory: displayPath,
      files: rendered.includedFiles,
    },
  });
}

/**
 * Register the memory tool and the per-turn memory loader.
 * @param ctx - plugin context owned by the Host row.
 * @param rowConfig - row configuration from the loader.
 */
export function apply(ctx, rowConfig) {
  const config = resolveRuntimeConfig(rowConfig);
  ctx.effect(() => ctx.tools.register(createMemoryTool({ ctx, config })), 'project-memory.tool');
  if (config.maxBytes <= 0) return;
  const sessionStates = new WeakMap();
  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next();
    try {
      if (decision.kind === 'reject' || signal.aborted) return decision;
      // Only real user turns load memory: a turn whose first step claimed no
      // user message must keep its "nothing to do" decision (the loop closes
      // such a turn when the entering step is empty).
      if (step !== 1 || messages.length === 0) return decision;
      const state = sessionStateFor(sessionStates, agent.session);
      const visible = visibleMemoryDigest(agent.session);
      if (visible !== state.digest) {
        state.digest = visible;
        state.fingerprint = undefined;
      }
      const message = await composeMemoryMessage(ctx, config, state, agent, signal);
      if (message === undefined || signal.aborted) return decision;
      return { ...decision, messages: [...decision.messages, message] };
    } catch (error) {
      if (!signal.aborted) ctx.logger.warn('project-memory: unable to load project memory: %o', error);
      return decision;
    }
  });
}
