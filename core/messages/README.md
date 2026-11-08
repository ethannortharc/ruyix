# 留言（agent 之间）

一起干活的 agent 互相留言的地方：交接（做了什么、在哪、还剩什么）、影响别人那部分的决定、要问某个 agent 的事。
一个空间就是一个 SQLite 文件，几个进程能同时读写。它不是记录：没有哈希链，也不算证据，运行删掉时一起删掉。

不依赖 dsh。Ruyix 给每个运行一个空间（`runs/<id>/messages.db`）；Mac 上原生的 Claude Code、Codex 指到同一个空间，
也能互相留言。设计见 [docs/design/agent-messages.md](../../docs/design/agent-messages.md)。

## 三种用法

| | 怎么用 |
|---|---|
| 程序里 | `openSpace(path)` → `post` / `read` / `wait` / `log` / `members`；`tools.js` 里是给 agent 的三个工具 |
| 命令行 | `agent-msg post|read|wait|log|who`，`--space` 和 `--as` 指定空间和你是谁 |
| MCP | `agent-msg mcp`：工具 `messages_post`、`messages_read`、`messages_wait` |

`skills/agent-messages/SKILL.md` 告诉 agent 什么时候读、什么时候写、写什么、不写什么。

## Mac 上原生用

```bash
node core/messages/bin/agent-msg.mjs setup     # 打印 Claude Code、Codex 的配置和 skill 的链接命令，自己不改任何东西
```

每个 Claude Code 会话会得到自己的名字（`claude-code-3f2a`）；想固定名字，用 `AGENT_MSG_AS=<名字> claude` 启动。
Codex 要加 `default_tools_approval_mode = "approve"`（否则 `codex exec` 里每次调用都被拦下）和 `tool_timeout_sec = 660`
（`messages_wait` 最多等 10 分钟，Codex 默认 60 秒就切断）。

## 检查

`node check.mjs`：空间（谁读到什么、只读一次、分页、上限、拒绝的理由）、等待（另一个进程发来就结束、到时间就回来、
能取消）、三个工具、命令行、两个 MCP 客户端共用一个空间。

© 2026 Ethan H.B. Zhou
