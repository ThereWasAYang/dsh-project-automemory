# dsh-project-automemory

Per-project automatic memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Every project gets its own private memory directory under the DSH home; the memory is loaded at the start of every conversation in that project and maintained through a model-facing `memory` tool.

Memory lives outside the project directory, so it is not shared across projects (unlike `~/.dsh/AGENTS.md`) and is not visible to other agents working in the checkout (unlike a project `AGENTS.md`).

The design follows Claude Code's auto-memory approach: project-private, automatically loaded, model-maintained, human-readable.

## Install

Requires DSH `^0.2.1-rc.5` (`engines.dsh` is declared; incompatible DSH versions refuse to activate this bundle).

**Option 1 — npm package (recommended)**

Install from the DSH Web Plugins page by searching for `dsh-project-automemory`, or use the CLI:

```bash
dsh plugin --profile <profile> add dsh-project-automemory
```

Or let an agent call `plugin_manager`:

```text
install_bundle  target = dsh-project-automemory
```

**Option 2 — GitHub source**

```text
install_bundle  target = https://github.com/ThereWasAYang/dsh-project-automemory.git
```

**Option 3 — local directory (development)**

```text
install_bundle  target = /path/to/dsh-project-automemory
```

New conversations use it immediately; existing conversations load memory at their next turn start.

## Memory directory

```
$DSH_HOME/projects/<project-slug>/memory/      # default: ~/.dsh/projects/...
├── .project.json                              # identity: absolute project path + createdAt
├── MEMORY.md                                  # index, loaded first
└── topics/…                                   # detail files, read/written through the memory tool
```

- **Project**: the first ancestor of the session working directory that contains `.git` (configurable through `projectRootMarkers`); otherwise the working directory itself.
- **Slug**: every character outside `[A-Za-z0-9_-]` of the absolute project path becomes `-`, e.g. `/Users/yang/Work/demo` → `-Users-yang-Work-demo`. When two projects encode to the same slug, the later one gets an 8-hex SHA-1 suffix and `.project.json` records the real path, so distinct projects never share memory.
- **Automatic loading**: every top-level `*.md` file in the directory is loaded at the first step of every turn. `indexFile` (default `MEMORY.md`) loads first; the rest sort by name. The complete rendering is bounded by `maxBytes`: whole files are dropped from the end before the index file is truncated.
- **Refresh**: each turn compares the directory fingerprint and the digest of the last injected snapshot. A changed, removed, or compaction-dropped memory snapshot is replaced on the next turn with a complete, explicitly marked replacement; unchanged memory costs no extra tokens.

The injected content is an ordinary sourced `user/message` (`<system-reminder>`-framed, `source.kind = "project-memory"`), so it replays, compacts, and resumes exactly like other session history.

## The `memory` tool

All paths are relative to the project memory directory.

| command | parameters | effect |
|---|---|---|
| `view` | `path` (omit or `/` to list) | list the directory or read a file |
| `create` | `path`, `file_text` | create a new file (fails if it exists) |
| `str_replace` | `path`, `old_str`, `new_str` | replace text that occurs exactly once |
| `insert` | `path`, `insert_line`, `insert_text` | insert text at a 0-based line |
| `delete` | `path` | delete a file |
| `rename` | `old_path`, `new_path` | rename or move a file |

The tool description tells the model that memory is project-private, loaded automatically, indexed by `MEMORY.md`, and must not hold secrets.

## Configuration

Override the Host row by id (`project-memory`) in the profile `cordis.patch.yml`:

```yaml
- id: project-memory
  name: 'dsh-project-automemory'
  config:
    maxBytes: 16384
    maxSourceBytes: 262144
    projectRootMarkers: ['.git']
    indexFile: MEMORY.md
```

## Relationship to `AGENTS.md`

This plugin is additive; it does not change DSH's existing AGENTS.md loading:

- `~/.dsh/AGENTS.md` stays **user-global**: suitable for cross-project preferences.
- A project `AGENTS.md` stays **repository-level workspace guidance**: suitable for team conventions committed to the repo.
- This plugin adds **project-private memory** for one user, one project, one machine: useful for "where did I leave off", project-specific pitfalls, and personal conventions.

Move project-specific content out of `~/.dsh/AGENTS.md` into the matching project memory directory; keep genuinely cross-project preferences there.

## How it differs from other DSH memory plugins

- Memory is stored **under `~/.dsh`, outside the project directory**: it is not distributed with the repository, does not disturb other agents working in the same checkout, and needs no Git commits.
- Memory is **maintained directly by the model** through the `memory` tool, with no human-approval workflow; at the same time memory is plain Markdown that a human can edit at any time.
- Memory is **loaded automatically every turn** and replaced automatically when it changes, with no `/memory` commands to run.
- Memory is keyed by the **project root (`.git`)**: one memory per monorepo, independent memory for separate repositories.

## Development and testing

```bash
# Node.js 24+
node --test                # 38 unit tests
npm pack --dry-run         # inspect the published file list
npm pack                   # build dsh-project-automemory-<version>.tgz
```

Publishing (maintainers):

```bash
npm login                  # register/log in to npm on first release
npm publish                # publishConfig.access = public is already declared
```

## Limitations

- Only top-level `*.md` files are auto-loaded; other files and subdirectories are reachable through the `memory` tool's `view` only.
- Memory is keyed by project root (`.git`): all subdirectories of a monorepo share one memory; separate repositories in one parent directory stay independent.
- External edits become visible at the next turn's start; writes made through the tool during a turn are loaded from the next turn onward.
- Memory is local `~/.dsh` data: it is not committed with the repository.
- Do not store secrets; `.project.json` records which absolute path owns a slug.

## License

MIT © 2026 ThereWasAYang
