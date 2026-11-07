# Changelog

## 0.1.0 — 2026-11-07

First public release.

- Per-project private memory directories under `$DSH_HOME/projects/<project-slug>/memory/`,
  created automatically for every project a conversation runs in.
- Automatic loading at the first step of every turn: top-level `*.md` files
  (index file `MEMORY.md` first) are injected as a durable, sourced
  `user/message` within an explicit UTF-8 byte budget.
- Content-digest refresh: changed, removed, or compaction-dropped memory is
  re-injected on the next turn with explicit replacement wording.
- Model-facing `memory` tool with `view`, `create`, `str_replace`, `insert`,
  `delete`, and `rename` commands, with lexical path containment and
  symlink rejection.
- Project identity recorded in `.project.json`, with SHA-1 slug-collision
  fallback so distinct projects never share memory.
- 38 unit tests (`node --test`) covering path safety, snapshot loading,
  store operations, and rendering budget behavior.
- English and Chinese plugin display metadata; original SVG icon.
