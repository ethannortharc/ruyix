# agent 之间的留言（设计）

2026-10-17 · Ethan：多 agent 的工作流里，agent 之间要能互相留言、同步消息（并行的步骤之间、前后步骤之间的交接）。
这只是 agent 和 agent 之间的沟通，不进记录，也不算证据。做成一个独立、通用的组件：一套留言和同步的机制，加一个 skill
教 agent 怎么用，能作为工作流的一部分打开或关掉；理想情况下，Mac 上原生的 Claude Code、Codex 等 agent 也能用，效果一样。

**状态（2026-10-17）：已做完。** 通用核心在 `core/messages`（检查 `check.mjs`；真实的 Claude Code 和 Codex 互相留言试过），
接进 workbench 在 `core/workbench/lib/messages.js`、`src/messages.jsx`（检查在 `check.mjs`「agents that message each other」）。
名字（「留言」、命令 `agent-msg`、包名）是工作名，等 Ethan 定。

## 和现有东西的区别

| | 记录（账本） | 留言 |
|---|---|---|
| 给谁看 | 人，以及以后的复查 | 正在干活的 agent |
| 写什么 | 每一步做了什么、证据、结果 | 交接、影响别人的决定、要问别人的事 |
| 能改吗 | 只增不删，带哈希链 | 不做哈希链；跟着运行走（运行只归档不删，留言也一样留着） |
| 谁写 | 引擎 | agent 自己决定 |

dsh 自带的 `send_message` 只在一个 dsh 会话里、父 agent 和子 agent 之间用；跨运行时（dsh、Claude Code、Codex）、
跨步骤的留言现在没有。

## 通用核心：`core/messages`（不依赖 dsh）

- **空间**：一个 SQLite 文件（`node:sqlite`，WAL，几个进程同时读写）。Ruyix 里每个运行一个：`runs/<id>/messages.db`；
  Mac 上原生用：`~/.agent-messages/<空间名>.db`（默认空间 `default`）。
- **一条留言**：谁发的、发给谁（一个名字，或者不写＝所有人）、话题（默认 `general`）、正文（最多 4000 字）、
  提到的文件（路径，最多 20 个）、回复哪一条、时间。
- **读到哪了**：每个名字有自己的位置，「读」只给还没读过的、发给自己或所有人的，不含自己发的。
- **三种用法，同一套东西**：
  - 程序里：`openSpace(path)` → `post` / `read` / `wait` / `log` / `members`。
  - 命令行：`agent-msg post|read|wait|log|who|mcp|setup`。
  - MCP stdio 服务（`agent-msg mcp`）：工具 `messages_post`、`messages_read`、`messages_wait`。
- **名字**：Ruyix 里由引擎定（`<智能体>@<步骤>`，比如 `writer@draft`），agent 自己改不了；原生用时取
  `--as` 或 `AGENT_MSG_AS`，都没有就用 MCP 客户端报的名字加一段随机后缀（`claude-code-3f2a`），每次回答都告诉它
  「你是谁」。
- **等待**：`wait` 最多等 10 分钟就回来（不会把两个互相等的 agent 卡死）；没等到就照自己的判断往下做，并留言说明。

## skill：`agent-messages`

告诉 agent 什么时候读、什么时候写、写什么、不写什么（`core/messages/skills/agent-messages/SKILL.md`）。
原生用时链接到 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`；Ruyix 里打开留言的工作流，步骤的 agent
自动带上它。

## Mac 上原生用

`agent-msg setup` 打印要执行的命令（不自己改配置文件）：

```bash
claude mcp add agent-msg -- node <路径>/core/messages/bin/agent-msg.mjs mcp --space default
# Codex：~/.codex/config.toml
# [mcp_servers.agent-msg]
# command = "node"
# args = ["<路径>/core/messages/bin/agent-msg.mjs", "mcp", "--space", "default"]
# default_tools_approval_mode = "approve"   # 不加的话 codex exec 里每次调用都被拦下
# tool_timeout_sec = 660                    # messages_wait 最多等 10 分钟，Codex 默认 60 秒就切断
```

指到同一个空间的会话就能互相留言，Claude Code 和 Codex 之间也行。

## 接进 Ruyix 的工作流

- 工作流设置里一个开关「agent 之间可以留言」（定义里 `messages: true`），默认关。
- 打开时：运行开始建自己的空间；每个 agent 步骤经现有的 workbench MCP 多三个工具（dsh 的 agent 也一样），名字由引擎
  按步骤填好；带上 skill。
- 运行页面多一个「留言」页签：按时间列出，谁发给谁、提到的文件能点开；人只看，不在这里发（人要说的话走现有的意见）。
- 不进记录，记录里也不写「发过留言」：要看沟通，看「留言」页签。

## 做的时候改了的

- 「读」不按发信人过滤：每个名字只有一个「读到哪了」，按发信人过滤会把别人的留言跳过去、再也读不到。`wait` 的
  `from` 只决定等到谁的留言才结束，读的时候还是把所有新的都给它。
- Codex 要两项设置：`default_tools_approval_mode = "approve"`（不然 `codex exec` 里每次调用都被拦下）和
  `tool_timeout_sec = 660`（`messages_wait` 最多等 10 分钟，Codex 默认 60 秒切断）。workbench 给 Codex 的 MCP
  本来就这样设。
