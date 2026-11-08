# Ruyix 的底座：名字和约定

底座是外壳、看板、连接器、工作流引擎、智能体池、盒子插件和盒子镜像；应用作为领域包加进来（`packs/`）。每一层做什么见
[README](../../README.zh-CN.md)，整体方案见 [os.md](os.md)。

## 统一的名字

- 包 `@ruyix/*`，命令 `ruyix`，dsh 配置 `ruyix`，端口 3280。
  - 包名里带不带 dsh（2026-10-17 定）：**现在不改**。改名要动几乎每个文件的 import，几个会话并行开发时代价大。DSH 先体现在
    README 的「built on DSH」和各包的 keywords（`dsh`、`dsh-plugin`、`deepseek-harness`）里。真要发布到公共 npm 时改成
    `@ruyix/dsh-*`（DeepSeek 自己的写法是 `@deepseek-ai/dsh-client-*`）：只给 dsh 插件（shell、connectors、workbench、
    agent-hub、box、apps、plume）加前缀，库（board、messages）不加；作用域保留——`ruyix install / upgrade / plugin add`
    靠 `@ruyix:registry=` 找源，不带作用域的 `dsh-ruyix-*` 会让这条路失效，公共 npm 上也可能被人抢注。改名时 `layout.json`
    里按包名记的插件开关要一起搬过去（凭据按连接 id 存，不受影响）。
- 状态都在 `~/.ruyix/` 下：外壳自己的文件在根上，`connectors/`、`agent-hub/`、`workbench/`、`box/` 各一个目录。
- 服务 `ruyixShell`、`ruyixWorkbench`、`agentHub`、`connectors`；界面插槽 `ruyix.*`；窗口全局 `window.__ruyix*`；事件 `ruyix:*`；
  样式变量 `--ruyix-*`。
- 面板 `agent-hub`、`ruyix-box`，接口 `/api/ruyix/*`、`/api/agent-hub`、`/api/ruyix-box`。
- 侧栏分组：工作台 · 应用 · 智能体 · 系统 · 盒子（`core/shell/src/nav.js`）。

© 2026 Ethan H.B. Zhou
