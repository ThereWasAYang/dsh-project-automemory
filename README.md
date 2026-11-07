# dsh-project-automemory

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**项目级自动记忆**插件。为每个项目在 DSH 主目录下建立**独立的私有记忆目录**，每次对话自动加载该项目记忆，并提供 `memory` 工具让模型维护记忆。

记忆保存在项目目录之外，因此：

- 不会像 `~/.dsh/AGENTS.md` 那样被所有项目共享、相互干扰；
- 不会像项目里的 `AGENTS.md` 那样被同一目录下其他 agent 读到；
- 换到另一个项目开会话时，加载的是另一个项目的记忆。

设计取向参考 Claude Code 的 auto memory：项目私有、自动加载、模型可维护、人类可读。

## 安装

需要 DSH 版本 `^0.2.1-rc.5`（`engines.dsh` 已在包内声明，不匹配的版本会被 DSH 拒绝激活）。

**方式一：npm 包（推荐）**

在 DSH Web 的 Plugins 页面搜索/输入 `dsh-project-automemory` 安装，或使用 CLI：

```bash
dsh plugin --profile <profile> add dsh-project-automemory
```

也可以让 agent 调 `plugin_manager`：

```text
install_bundle  target = dsh-project-automemory
```

**方式二：GitHub 源码**

```text
install_bundle  target = https://github.com/ThereWasAYang/dsh-project-automemory.git
```

**方式三：本地目录（开发用）**

```text
install_bundle  target = /path/to/dsh-project-automemory
```

安装后对**新会话**立即生效；已存在的会话会在下一轮对话开始时加载记忆。

## 记忆目录

```
$DSH_HOME/projects/<项目 slug>/memory/          # 默认 ~/.dsh/projects/...
├── .project.json                               # 记忆身份：绝对项目路径 + 创建时间
├── MEMORY.md                                   # 索引（默认第一个加载）
└── topics/…                                    # 细节文件，通过 memory 工具按需读写
```

- **项目**：从会话工作目录向上找到第一个包含 `.git` 的目录作为项目根；找不到时就用工作目录本身。可通过 `projectRootMarkers` 配置改变标记名。
- **slug**：把项目绝对路径中除 `[A-Za-z0-9_-]` 外的字符替换成 `-`，例如
  `/Users/yang/Work/demo` → `-Users-yang-Work-demo`。若两个项目编码后同名，第二个会追加路径 SHA-1 前 8 位作为后缀；`.project.json` 记录真实路径，保证不同项目不会共用记忆。
- **自动加载**：目录下所有顶层 `*.md` 文件都会在**每轮对话的第一步**被读取并注入，其中 `indexFile`（默认 `MEMORY.md`）排在最前，其余按文件名排序；受 `maxBytes` 字节预算约束，超预算时从后往前整文件舍去，最后才截断索引文件。
- **更新检测**：每轮开始时对比目录指纹与已注入快照的内容摘要。记忆被修改、删除，或因压缩从历史中丢失时，下一轮会重新注入**完整的最新快照**并用 "replaced the previously loaded project memory" 措辞说明；内容未变则完全不占用额外 token。

注入内容是一条带 `source.kind = "project-memory"` 的普通 user 消息（`<system-reminder>` 包裹），因此可重放、可压缩、可恢复，与 DSH 会话日志机制一致。

## `memory` 工具

模型可通过 `memory` 工具维护当前项目的记忆，路径均相对于该项目的 memory 目录：

| command | 参数 | 作用 |
|---|---|---|
| `view` | `path`（省略或 `/` 表示列目录） | 列出目录或读取文件内容 |
| `create` | `path`、`file_text` | 新建文件（已存在则报错） |
| `str_replace` | `path`、`old_str`、`new_str` | 替换在文件中**恰好出现一次**的文本 |
| `insert` | `path`、`insert_line`、`insert_text` | 在指定行（0 基）插入文本 |
| `delete` | `path` | 删除文件 |
| `rename` | `old_path`、`new_path` | 重命名/移动文件 |

工具描述里已包含「记忆是项目私有、每次对话自动加载、`MEMORY.md` 作索引、不要存密钥」等使用约束，模型会主动在学到值得长期保留的项目知识时写入。

也可直接编辑 `~/.dsh/projects/<slug>/memory/` 下的 Markdown 文件（人类可读，无需工具），改动会在该会话下一轮或之后的新会话中生效。

## 配置

在 profile 的 `cordis.patch.yml` 中按行 id `project-memory` 覆盖：

```yaml
- id: project-memory
  name: 'dsh-project-automemory'
  config:
    maxBytes: 16384            # 注入上下文的字节预算
    maxSourceBytes: 262144     # 单个记忆源文件上限
    projectRootMarkers: ['.git']  # 项目根标记
    indexFile: MEMORY.md       # 优先加载的索引文件名
```

## 与 `AGENTS.md` 的关系

本插件是**增量**机制，不改变 DSH 既有的 AGENTS.md 加载行为：

- `~/.dsh/AGENTS.md` 仍是**用户全局**指令，所有项目共享 —— 适合放跨项目的个人偏好，不适合放项目细节；
- 项目里的 `AGENTS.md` 仍是**仓库级工作区指令**，同一目录下每个 agent 都会读到 —— 适合提交进仓库的团队约定；
- 本插件提供**项目私有记忆**，只属于你这个用户、这个项目、这台机器 —— 适合放"我上次做到哪、这个项目有哪些坑、这个目录下我偏好的做法"。

建议把 `~/.dsh/AGENTS.md` 中已有的项目相关段落迁移到对应项目的 memory 目录，只保留真正跨项目的偏好。

## 与其它 DSH 记忆插件的区别

- 记忆存放在 **`~/.dsh` 之下、项目目录之外**：不随仓库分发，不干扰在同一 checkout 里工作的其他 agent，也不需要提交进 Git。
- 记忆由**模型直接维护**（`memory` 工具），不需要人工审批流程；同时记忆是普通 Markdown，人可以随时直接改。
- **每轮对话自动加载**并在变化时自动替换旧快照，不需要手动 `/memory` 命令。
- 采用**项目根（`.git`）**作为归属单位：monorepo 内共享一份记忆，不同仓库相互独立。

## 开发与测试

```bash
# 需要 Node.js 24+
node --test                # 38 个单元测试
npm pack --dry-run         # 检查发布产物文件列表
npm pack                   # 生成 dsh-project-automemory-<version>.tgz
```

发布（维护者）：

```bash
npm login                  # 首次发布需先注册/登录 npm 账号
npm publish                # 包内已声明 publishConfig.access = public
```

## 限制

- 自动加载仅限 memory 目录**顶层**的 `*.md` 文件；其他文件（含子目录、非 md 文件）只能通过 `memory` 工具的 `view` 读取。
- 记忆按「项目根（`.git`）」归属：monorepo 内所有子目录共享同一份记忆；多个仓库共用同一父目录时各自独立。
- 外部编辑（非本插件工具写入）在下一轮对话开始时生效；同一轮内的改动不会即时重注入。
- 记忆是本机 `~/.dsh` 数据，不随仓库同步；`maxBytes` 控制每次对话的记忆 token 开销。
- 不要存放密钥；slug 与项目路径的对应关系记录在 `.project.json`。

## License

MIT © 2026 ThereWasAYang
