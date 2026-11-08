# @ruyix/web — 搜索和打开网页

所有智能体搜索网页、打开网页，都用这里配的服务。设计见 [docs/design/search.md](../../../docs/design/search.md)。

- **搜索**：DeepSeek（Search API）、Tavily、博查、Exa、Brave。设置 → 搜索里勾选、排顺序：第一个先用，它答不上来（没 key、
  出错、额度用完）就用下一个。
- **打开网页**：先直接打开（挡住本机、内网、云的元数据地址：解析出来的地址在连接时查，跳转每一跳都查）；打不开，或页面是脚本
  画出来的、几乎没有文字，就按顺序用 Jina Reader 或 DeepSeek Fetch。
- **密钥**：和模型的密钥一样存（`/api/ruyix/credential`）——盒子里真实的值进主机的保险库，盒子里只留占位符，网关在发往那家的
  地址时换回去；每次调用时现取，这里不留。DeepSeek 的搜索和打开网页用模型的 `DEEPSEEK_API_KEY`。
- **谁在用**：dsh 的智能体用 dsh 自己的 `web_search` / `web_fetch`（`cordis.patch.yml` 把这里的两个设成 dsh 的默认，并打开
  dsh 关着的打开网页）；Claude Code、Codex、pi 由 Agent Hub 给一个 MCP（`web-mcp.mjs`，工具同名），它们自带的搜索也还在。

| 文件 | 内容 |
|---|---|
| `lib/services.js` | 各家的请求和返回（整理成 dsh 的统一格式） |
| `lib/guard.js` | 直接打开网页时的防护 |
| `lib/serve.js`、`web-mcp.mjs` | 给命令行智能体的路 |
| `index.js` | 两个分发器、设置（`~/.ruyix/web.json`）、`/api/ruyix-web`（state、save、test） |
| `src/main.jsx` | 设置 → 搜索 |

检查：`node check.mjs`（不连网：各家对着假的返回，防护，顺序和备用，MCP 走真的套接字）。

© 2026 Ethan H.B. Zhou
