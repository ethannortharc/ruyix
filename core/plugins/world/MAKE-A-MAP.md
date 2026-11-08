# 做一张自己的交互式桌面地图

交互式桌面（设置 → 通用 → 界面 → 交互式）把整个桌面画成一张图：每个页面、每个在跑的任务、每个智能体都是图上的一个地方。
自带三张：**古地图**、**星图**、**未来**。别的样子任何人都能自己做：做一个小插件，交给 `@ruyix/world` 登记就行。

地图之间**只有长相不同**。哪些地方、放在哪、任务和智能体怎么摆、拖动和缩放、点了打开哪个页面、名字和状态文字，这些都由
`@ruyix/world` 统一处理（`World`）。一张图要给的只是一份**定义**：

| 字段 | 是什么 |
|---|---|
| `id` | 唯一的名字，比如 `blueprint`。样式里用 `.wd-blueprint`，窗口用 `.ad-root[data-world="blueprint"]` |
| `name` | `{ zh, en }`，显示在设置里和右下角「换一张图」按钮上 |
| `tone` | `dark` 或 `light`：底图是深色还是浅色（决定字用浅色还是深色） |
| `scene` | 底图：一段片元着色器（GLSL），见下文 |
| `icons` | 每类地方一张 SVG：`capital`（主智能体）`harbor`（任务）`launch`（新建任务）`post`（收件箱）`library`（工作流）`guild`（智能体）`workshop`（应用）`port`（连接器）`fort`（box）`archive`（记录）`settings` `gate`（回到普通桌面）`village`（别的插件的页面，上面会叠那个页面自己的图标）。可以直接用 `ATLAS_ICONS` / `SKY_ICONS` |
| `css` | 名字、按钮、提示框、窗口边框的样式 |
| `words` | 可选，`{ zh, en }`，换掉共用的几句话（比如 `launchHint`：「新建任务」下面那行小字） |
| `road` / `below` | 可选：智能体站在任务环的什么位置（占半径的比例，1 是正好在环上）；任务名写在环下面几个半径处 |
| `theme` | 可选：这张图当桌面时，各个页面跟着换的颜色和圆角（下文） |
| `land` / `figures` / `isles` | 可选，古地图和星图用的：每类地方的岛有多大；每个地方画成一个真实的星座（`figures`，`src/constellations.js`）；每个地方是一座真实的岛（`isles: true`，`src/islands.js`，海岸线来自 Natural Earth） |

## 最快的做法：从模板改

`template/` 是一个能直接用的小插件，画的是一张「蓝图」（蓝纸白线）。复制一份，改这几处：

1. `package.json` 的 `name`（比如 `@你的作用域/world-mymap`）、`cordis.patch.yml` 里的 `id` 和 `name`。
2. `src/main.jsx` 里定义的 `id`、`name`、`icons`、`words`、`theme`。
3. `src/scene.js`：底图怎么画。
4. `src/map.css`：字和窗口的样子。
5. `npm install && node build.mjs`，生成 `client.js`。

## 底图（scene）

底图是一段每个像素都跑一遍的片元着色器，由外壳的壁纸引擎来画：

```js
{ data: true, fps: 20, tone: 'dark', c: ['#123a6b', '#e8f1ff', '#ffd27a', '#7fb2ff'], fn: `…函数和 uniform 声明…`, body: `…给 col 赋值…` }
```

- `c` 四个颜色，着色器里是 `uA`～`uD`。`fps` 是每秒最多画几帧，越低越省电。
- `body` 里能用：`p`（屏幕上的点，中心是原点，屏幕高为 1）、`uv`（0～1）、`t`（秒）、`uK`（主智能体有多活跃：在听、在说时变大）。
  还有噪声函数：`n2` `fbm` `fbm3` `hash` `hash22`。
- 世界坐标：`vec2 w = p * uV.z + uV.xy; float px = max(uP, 0.5) / uR.y * uV.z;`。`w` 是这个像素对应的地图上的点，`px`
  是一个页面像素在地图上有多长（画一条一像素的线就用它）。整张图大约宽 3.5、高 1.96，中心在原点，y 轴朝上。
- 每一帧 `world.jsx` 会把画面上的东西传进来，名字和含义见 `template/src/scene.js` 文件头。主要有：
  - `uMark[24]` / `uMarkB[24]`：各个地方。`uMark[0]` 永远是主智能体。地方的类别编号见 `src/layout.js` 的 `KINDS`，编号 14 是时钟，不用画。
  - `uTask[8]` / `uTaskB[8]`：任务。种类 1 是在跑，2 是等人，3 是定时，4 是刚做完；还有一共几步、做完几步、正在做第几步。
  - `uStar[16]` / `uStarB[16]`：智能体，在哪、上次动作的时间、是谁（0 claude、1 codex、2 dsh、3 系统、4 人）。
  - `uLink[8]` / `uLinkB[8]`：智能体之间正在传的留言，从哪到哪。
  - `uN`：几个任务、几个智能体、鼠标停在哪个任务上。`uV`：当前视野。
- 着色器编译不过时，桌面会退回成用 `c` 四色画的渐变，浏览器控制台里有一行
  `ruyix wallpaper world-<id>: <错误>`。
- 需要 `dFdx` / `fwidth`（比如做浮雕光影）时加 `derivatives: true`。
- 要用自己的数据图（比如古地图每座岛离海岸多远的那张图）时加 `tex: { uName: () => ({ width, height, data }) }`：
  每个像素一个字节，第一次画的时候生成一次，着色器里是 `uniform sampler2D uName`，读 `.r`。
- 注释别和收尾的 `}` 写在同一行（`fog = …; // 说明 }`）：注释会把 `}` 吞掉，整段着色器编译不过，地图一片黑。`check.mjs` 会查这个。

几点经验：

- **自带的三张图都不在地上放图标、也不常显示名字**：鼠标指上去时那个地方亮起来、名字出现（名字仍在网页元素里，
  读屏和键盘都能用）。做法是在你的 `css` 里把 `.wd-icon` / `.wd-count` 藏起来，`.wd-name` 平时透明、`.wd-hot` 时显示；
  能点的范围：星座用 `--fig`（`World` 按星座大小每帧设好），平台用固定大小，真实的岛按岛的形状判断（`isles`）。
- **地方的图标和名字是网页元素，不是着色器画的。** 着色器画「地」，图标和名字由 `World` 叠在上面。地方底下的图形
  （平台、岛、光晕）要比图标大一圈，名字才不会压在上面。图标随缩放只会放大一点（`placeScale`：视野缩放比的 0.45 次方，
  限制在 0.75～1.5）。想让底图上的图形和图标一起变大，就照这个规则算，`future-scene.js` 里的 `u` 就是这么算的。
- 每个像素都要循环 24 个地方、8 个任务、16 个智能体，循环里别再套大循环；离得远的像素尽早 `continue`，但要保证跳过前后
  画出来一样（否则在跳过的边界上会多出一道线）。引擎会量每帧花多少时间，太慢时自动降低清晰度（在 Retina 屏上看着会糊）。
- 右下角那排按钮（说话、全屏、放大缩小、全图、换图）是 `World` 统一画的，地图不用管，只用在 `css` 里给它们配上自己的样子。
- 时间 `t` 会一直变大，周期运动要用 `sin` / `fract`，别让位置跟着 `t` 一直走。

## 页面跟着图走（theme）

```js
theme: { tokens: { '--ruyix-accent': ['#1f5fbf', '#8cb8ff'], '--ruyix-canvas': ['#eef3fa', '#0b1a2e'], '--ruyix-radius-k': '0.5' } }
```

这张图当桌面时，这些设计变量会盖到整个页面上，所以各个应用、设置、面板也跟着换颜色。每个值写 `[浅色, 深色]` 两份，
人自己选的浅色或深色模式不变，两份都要清楚好读。不要强制深色：dsh 自己的一部分界面不跟着变，会出现深底深字。
能改的变量见 `core/shell/tokens.css`。常用的有 accent、canvas、chrome、surface、surface-sunk、hover、line、line-strong、title、text、
text-muted、text-dim，以及 `--ruyix-radius-k`（圆角倍数，1 是标准）。

## 窗口的样子

点一个地方打开的页面放在窗口里。窗口的边框和标题栏用 `.ad-root[data-world="<id>"] :is(.ad-win, .ad-xwin)`，
它的 `.ad-titlebar` 和 `.ad-title` 来定。可以参考 `src/atlas.css`（旧纸双线框）、`src/sky.css`（星光）、`src/future.css`（发光细线和四角）。
设置里的「窗口透明度」开着时（`html[data-ruyix-see]`），窗口会透出后面的地图：标题栏的底色要给一份半透明的
（`:root[data-ruyix-see] .ad-root[data-world="<id>"] :is(.ad-win, .ad-xwin) .ad-titlebar { background: color-mix(in srgb, <颜色> var(--ad-see-card), transparent) }`）。

## 装上

插件和 Ruyix 别的插件一样，从 npm 源安装，并且核对安装包的 sha512：

```bash
npm publish                                   # 发到你的源（公司的、自己搭的都行）
ruyix plugin add @你的作用域/world-mymap@0.1.0 --integrity sha512-… --registry https://你的源/
```

装好后，设置 → 通用 → 界面 → 交互式，「哪张图」里就有它。地图插件依赖 `@ruyix/world`，`@ruyix/world` 要开着。

## 参考

- `src/sky.jsx` + `src/scenes.js` 的 `SKY`：星图（真实的星座、星云）。
- `src/atlas.jsx` + `src/scenes.js` 的 `ATLAS`：古地图（真实的岛、浮雕光影、旧海图、旧纸）。
- `src/future.jsx` + `src/future-scene.js`：未来（太空里看的城市夜景、发光平台、高速公路、全息环）。
- `template/`：最简单的一张，从这里开始改。

© 2026 Ethan H.B. Zhou
