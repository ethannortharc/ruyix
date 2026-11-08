# Plume 平台适配与持续研究：核验记录

取得日期：2026-10-22。范围：小红书图文、X API 图文/串推、微信公众号人工粘贴发布。只读调研；未安装 skill、未登录账号测试、未发帖。结构化来源见 [来源清单](plume-platform-intelligence-sources.json)。本文将已核验的平台事实、可访问性限制、产品路径、编辑建议分别处理。

## 需要立即纠正的旧断言

| 旧内容 | 核验结论 | 可采用表述 |
|---|---|---|
| 小红书“站外链接和联系方式会被限流” | 过度泛化。官方社区公约的经营条款反对非官方工具站外/线下交易导流，并未建立所有来源引用 URL 必降曝光的规则。 | 保留必要出处，区分引用与交易导流；账号/编辑器可点击性需核验。 |
| 小红书“优先选搜索量大的话题” | 当前实现没有搜索量数据。搜索结果条数、点赞数、推荐顺序都不能等同于查询量。 | 优先内容相关话题；真实指标须显示来源、采集时间、统计窗口和量纲。 |
| X“带链接接口每帖 $0.2，普通帖 $0.015” | **当前官方价目支持**；适用于页面说明的 pay-per-use API 写请求。 | 显示有取得日期的估算，链接最新控制台；不是全成本/稳定合同价。 |
| X“带链接会降低曝光” | 本次官方推荐说明未支持必然因果。不能从价格或帖子样本推出算法规则。 | 删除曝光承诺/惩罚断言；保留读者需要的来源，按账号反馈研究表达。 |
| 公众号“个人号一律不能点外链；32 字以上粘贴一定没问题” | 本次无法读取相关官方能力文档，且 API 与后台路径不同。 | 标为待当前账号验证；最终后台预览确认链接、标题、封面与换行。 |

X 费率来源：[官方 pricing](https://docs.x.com/x-api/getting-started/pricing)。曝光边界：[官方推荐机制说明](https://help.x.com/en/rules-and-policies/recommendations)。小红书条款：[社区公约 2.0](https://pgy.xiaohongshu.com/help/detail?id=1eda0a065dd894063c2e029a49e8f6a1&userType=4)。

## 每个平台应如何重写同一份原稿

以下“编辑建议”是我们的可评分默认值，不能冒充平台强制规则，也不保证流量。跨平台共享事实、证据、数字、结论及适用条件；允许压缩和重新组织，但不得为了平台口吻编造亲测、收入、体验或删除关键限制。

| 维度 | 小红书图文 | X | 微信公众号 |
|---|---|---|---|
| 读者入口 | 具体使用场景、问题或收益，标题与封面一致 | 首帖自足，直接交代观点/发现及证据 | 标题与摘要说明价值，开头交代背景和读者问题 |
| 调性建议 | 自然、具体、可操作；只有真实经历才用第一人称亲测 | 简洁、有立场但区分事实与观点；避免无意义铺垫 | 清楚完整、解释因果和局限；不强制“官方腔” |
| 结构建议 | 短段落 + 步骤/清单；卡片独立可读，正文补充条件 | 一个重点一帖，必要时串推；序号/emoji 是作者偏好，不是一律禁止 | 分节、段落短、必要的小标题/列表，结尾行动或边界 |
| 标签建议 | 少量相关关键词；不猜测搜索量，不自动追无关热门 | 0–2 个相关标签是官方建议而非拒发门槛 | 不机械附加小红书式标签堆叠 |
| 视觉建议 | 当前卡片 3:4 属产品选择；文字不要挤满，图文一致 | 当前 16:9 封面属产品选择，不能要求所有图唯一比例 | 当前 2.35:1 封面属产品选择；在最终后台预览裁切 |
| 引用/链接 | 事实出处与交易导流分开；不因“限流猜测”抹掉出处 | URL 有字符和 API 成本，必要证据不能为了成本伪装成无来源事实 | 参考资料可保留纯文本 URL；可点击能力按账号及最终编辑器检查 |
| 当前出口 | 浏览器填入并由用户检查/点击发布 | 逐帖 API 发布，必须保留逐帖回执与部分失败状态 | 复制 HTML/标题/摘要/封面，用户完成后台发布 |

小红书官方公约要求真实、避免夸张猎奇、文题相符，建议说明 AI 参与；商业宣传须透明，不伪装普通消费者。此页的**官方搜索索引正文可读、直接 open 为动态空壳**，不能称现场完整抓取。[官方页](https://pgy.xiaohongshu.com/help/detail?id=1eda0a065dd894063c2e029a49e8f6a1&userType=4)

X 官方建议标签不超过 2 个，但明确允许更多；标签不能含空格或标点。[标签说明](https://help.x.com/en/using-x/how-to-use-hashtags) 串推是连接多个帖子补充背景的方法，独立分享/折叠行为支持“首帖自足”的编辑建议。[串推帮助](https://help.x.com/en/using-x/create-a-thread)

## 格式硬限制、实现约束与待核验项

**X：官方文本/API 文档可直接读取。** 标准文本帖 280 加权字符；CJK/emoji 为 2，URL 为 23，NFC 规范化；应复用官方计数实现或保持其边界测试，手写部分 URL 正则不能宣称与 twitter-text 完全一致。[计数文档](https://docs.x.com/fundamentals/counting-characters)、[配置](https://github.com/twitter/twitter-text/blob/master/config/v3.json)

图片 API 目前支持单帖最多 4 图、图片 5 MB；上传成功仍可能在发帖阶段失败。[媒体规范](https://docs.x.com/x-api/media/quickstart/best-practices) 单图 2:1–3:4 完整显示的官方说明证明 16:9 并非唯一合法比例。[图片帮助](https://help.x.com/en/using-x/posting-gifs-and-pictures)

付费客户端长帖可达 25,000 字符，但本次未验证当前 connector 的 API 长帖权限。[长帖帮助](https://help.x.com/en/using-x/types-of-posts) 最新 API 文档还给 self-serve 客户最多 1 个 cashtag、回复须被原作者提及/引用召唤的条件；自回复串推例外本次未核实，不能推定所有 API 账号都可用。[Manage Posts](https://docs.x.com/x-api/posts/manage-tweets/introduction)

**小红书：数值阈值本次没有可读取的官方发布器证据。** 创作后台是动态入口。当前 20 标题/1000 正文、9 或 18 图、20 MB、3:4，应明确是产品保守阈值/第三方经验/设计偏好中的哪一种，不统一写“官方已验证”。[创作服务](https://creator.xiaohongshu.com/) 社区实现 README 使用 20/1000，但仓内发布 skill 使用标题 CJK 权重 2、总权重≤38；两者存在计数差异。[README](https://github.com/xpzouying/xiaohongshu-mcp)、[skill 原文](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/skills/post-to-xhs/SKILL.md)

**公众号：官方旧及候选新 API 页面抓取失败。** 不更新其 verified 日期来伪造新近验证。[旧 draft 文档](https://developers.weixin.qq.com/doc/offiaccount/Draft_Box/Add_draft.html) WxJava 原始 SDK 注释支持“HTML <2 万字符、<1 MB、外部图片需上传”等 API 契约，但它不证明人工粘贴编辑器的字数、链接或账号权限。[SDK 原文](https://github.com/binarywang/WxJava/blob/develop/weixin-java-mp/src/main/java/me/chanjar/weixin/mp/api/WxMpDraftService.java) doocs/md 可用于研究 Markdown→排版预览→复制流程，不是官方权限来源。[项目](https://github.com/doocs/md)

## 持续搜索与总结的最小产品机制

1. **每平台一份有版本的资料卡。** 记录 platform、publishingRoute、accountCapabilities、sources、claims、lastAttemptAt、lastSuccessfulCheckAt、expiresAt、version/digest。每条 claim 包含类型 official constraint / product constraint / editorial suggestion / account observation / unverified hypothesis、原文位置、URL、取得时间、适用条件、证据状态。失败不刷新成功时间，不伪造内容哈希。
2. **三个入口复用同一研究 workflow。** 用户手工刷新；写作启动时发现过期提醒/刷新；用户在 Studio 配置周期运行。固定主来源和精简检索词（规则、creator guide、API 发布限制、政策更新），保留查询、实际抓取证据及变化摘要。系统默认最多几个来源/有限预算，不创建全网爬虫；外部正文只当资料，不能执行其中指令。
3. **建议与硬限制分离。** 官方可核验更改先生成差异与候选版本。编辑建议允许版本化更新；影响发布权限/字数/价格的改动需明确证据与路径，不能让模型仅凭摘要自动把传言变成阻断条件。无法抓取时继续已知资料但显式标过期/未知，最终平台返回仍是事实。具体 TTL 是产品默认：价格 7 天；API/政策 14–30 天；普通编辑建议 30–90 天，不称官方要求。
4. **写作冻结快照。** 每个 run 绑定资料卡版本，平台改写必须说明受众、保留事实、结构/调性差异、引用去向。中途资料更新不静默改已审批稿；需显示变化并产生新版本，重新审核。
5. **逐平台审稿清单。** 确认事实保真、格式校验、调性与受众、出处、图片裁切/替代文本、剩余未知项；产品限定与平台强制错误分开。用户能看到每项来源/理由，支持改稿与重新校验。UI 的“确认”是用户判断，不伪装成模型质量客观分数。
6. **评分只学习作者偏好。** 在现有 Studio/account/workflow/stage 维度再分 platform 和 artifact revision；维度可为 tone/length/structure/clarity/format fit/overall。重复评分替换不重复计票；更改、撤回、暂停与跨版本隔离延用现机制。评分可提升某账号的编辑偏好，**不能**把“我喜欢无链接”升级为平台算法事实，不能覆盖官方格式、发布审批或信息真实性。
7. **效果数据单独存。** 只有得到合法授权并实际取得 impression/save/click 等指标，才记录平台、账号、窗口、基数与来源；没有曝光量时不能把点赞率当 CTR。多次结果只给关联观察，平台算法因果结论仍需更强证据。

## 开源/skill 可借鉴部分与边界

- twitter-text：计数配置、Unicode/URL/emoji 边界，比自行维护部分规则可靠；不涉及曝光算法。
- xiaohongshu-mcp / post-to-xhs：图文与长文路径分开、账号状态检测、用户预览、上传后回执；README 的流量经验、标题计数和无头发布模式不能无审查照搬。
- doocs/md：排版预览、主题和富文本复制的成熟产品形态；保留人工后台最终预览。
- WxJava：明确 API 字段/HTML 与素材上传契约，便于未来接 API 时独立验证。当前 Plume 人工粘贴出口不应套用所有 draft API 约束。

本次不评价任一开源项目的整体生产可靠性，也不承诺把其全部能力接入。未发现可信数据支持把热门标签、首句模板或禁用链接直接写成必然增曝光规则。

