# 搜索和抓网页（设计）

2026-10-18 · Ethan：智能体经常要搜索。DeepSeek 有搜索的接口，也有别的搜索工具；在设置里加一块，配好用哪家、填 key，智能体搜索
和抓网页就用配的那家。这些搜索接口和工具要集成进来，做成基础设施。

他定的（2026-10-18）：

- **搜索服务**：DeepSeek（10 月 17 日刚出的 Search API）、Tavily、博查、Exa、Brave。
- **抓网页**：先直接抓，抓不到再用 Jina；DeepSeek 的 Fetch API 也接上，当另一个备用（便宜）。
- **Claude Code、Codex**：它们自带的搜索留着，这里配的也给它们，两个都在。

## 现在的样子

dsh 有一个网络能力的接口（`ctx.web`）：给智能体的工具是 `web_search`、`web_fetch`，后面接哪家由配置定。dsh 自带的配置把搜索
定成 DeepSeek 原生搜索（一次完整的模型调用，慢、贵），抓网页整个关掉（那个接法没挡住访问内网地址）。Claude Code、Codex 用它们
自己的搜索；pi 没有。

## 做法

- **一个插件 `@ruyix/web`**：往 `ctx.web` 里注册两个分发器——`ruyix-search`、`ruyix-fetch`——按设置去调用选中的服务，第一个出错
  时用备用的；用配置补丁把这两个设成 dsh 的默认，把抓网页打开。
- **各家**（都按官方接口；返回整理成 dsh 的统一格式：标题、地址、摘要、日期）：

  | 服务 | 搜索 | 抓网页 | 密钥 | 地址 |
  |---|---|---|---|---|
  | DeepSeek | `POST /v1/tools/search` | `POST /v1/tools/fetch` | 和模型共用 `DEEPSEEK_API_KEY` | api.deepseek.com |
  | Tavily | `POST /search` | — | `TAVILY_API_KEY` | api.tavily.com |
  | 博查 | `POST /v1/web-search` | — | `BOCHA_API_KEY` | api.bochaai.com |
  | Exa | `POST /search` | — | `EXA_API_KEY` | api.exa.ai |
  | Brave | `GET /res/v1/web/search` | — | `BRAVE_API_KEY` | api.search.brave.com |
  | Jina | — | `GET r.jina.ai/<网址>` | `JINA_API_KEY`（可不填） | r.jina.ai |
  | 直接抓 | — | 直接请求网页 | — | — |

- **直接抓**挡住本机、内网、云的元数据地址（解析出来的 IP 也查），跟着跳转时每一跳都查；页面大小、时间有上限。
- **密钥**：和模型的密钥一样——盒子里真实的值进主机的保险库，盒子里只留占位符，发到那家的地址时网关换回去；不在盒子里就存在
  dsh 的凭据里。设置页只显示「已配 / 未配」，从不读回来。
- **设置 → 搜索**：搜索用哪家、备用哪家，抓网页的顺序；每家一个 key 的格子和「去哪里拿 key」；「试一下」当场搜一次 / 抓一次，
  看结果和花了多久。
- **智能体**：dsh 的智能体（主智能体用 dsh 时、工作流里 dsh 的步骤）自动用 `web_search` / `web_fetch`；Claude Code、Codex、pi 加一个
  MCP（`ruyix-web`）给它们同样的两个工具，自带的也留着。

## 先后

1. 插件：各家的搜索和抓网页、分发、直接抓的防护、设置的存储和「试一下」；检查（不连网，假的返回）。
2. 设置页。
3. 给 Claude Code、Codex、pi 的 MCP。
4. 盒子里用真的 key 试：DeepSeek 搜索、抓一个网页；主智能体搜一次。

© 2026 Ethan H.B. Zhou
