// Source-backed baseline, researched 2026-10-22. Editorial observations are explicitly product defaults.
// Failed/index-only retrievals remain visible as unknowns and must not substantiate automatic factual guidance.
export const PLATFORM_SEEDS = {
  "xhs": {
    "platform": "xhs",
    "revision": "seed-2026-10-22",
    "researchedAt": "2026-10-22T00:00:00.000Z",
    "expiresAt": "2026-11-05T00:00:00.000Z",
    "summary": "采用图文笔记的场景化表达和可读卡片。官方公约本次仅索引可读，发布器数值仍需当前账号核验。",
    "sources": [
      {
        "id": "xhs-covenant",
        "url": "https://pgy.xiaohongshu.com/help/detail?id=1eda0a065dd894063c2e029a49e8f6a1&userType=4",
        "title": "小红书社区公约 2.0",
        "publisher": "小红书蒲公英帮助中心",
        "authority": "official",
        "availability": "index-only",
        "publishedAt": "2026-07-31",
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "强调真实原创、核实存疑内容、文题相符，反对夸张猎奇和虚假人设。 建议 AI 辅助创作主动标明；商业经营应透明，勿通过非官方工具引导站外或线下交易。 搜索结果含官方正文；直接页面为动态空壳。商业交易导流规则不能扩大为所有学术/事实引用链接必限流"
      },
      {
        "id": "xhs-creator",
        "url": "https://creator.xiaohongshu.com/",
        "title": "小红书创作服务平台",
        "publisher": "小红书",
        "authority": "official",
        "availability": "inaccessible",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "动态/登录编辑器；标题/正文/图数的账号实际限制本次未实测"
      },
      {
        "id": "xhs-mcp-readme",
        "url": "https://github.com/xpzouying/xiaohongshu-mcp",
        "title": "xiaohongshu-mcp README",
        "publisher": "xpzouying",
        "authority": "observed",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "该社区实现 README 使用标题 20 字、正文 1000 字的约束，并包含作者个人运营经验。 不是官方规则；作者流量结论/日发帖数不能升级为通用事实；与仓内 skill 标题计数不一致"
      },
      {
        "id": "xhs-publish-skill",
        "url": "https://github.com/xpzouying/xiaohongshu-mcp/blob/main/skills/post-to-xhs/SKILL.md",
        "title": "post-to-xhs SKILL.md",
        "publisher": "xpzouying/xiaohongshu-mcp",
        "authority": "observed",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "区分上传图文与长文流程、显式呈现内容确认、上传后检查结果。 该 skill 标题规则为 CJK 权重 2、总权重≤38，与 README 简述存在差异。 借鉴流程模式；未安装、未执行；不能把其阈值或自动发布策略当作我们的授权或官方规定"
      }
    ],
    "observations": [
      {
        "id": "xhs-audience",
        "dimension": "audience",
        "statement": "围绕明确读者的具体场景或问题，保留事实、适用条件和出处；不要虚构亲测经历。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "xhs-opening",
        "dimension": "opening",
        "statement": "标题与封面/正文一致，用具体信息表达价值，避免夸张承诺；首段直入问题。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "xhs-structure",
        "dimension": "structure",
        "statement": "短段落配步骤或清单；卡片独立可读，正文补充操作条件，不把长文机械截断。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "xhs-tone",
        "dimension": "tone",
        "statement": "自然具体，只有原稿包含真实经历时才采用第一人称经验口吻。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "xhs-tags",
        "dimension": "tags",
        "statement": "选择少量与内容准确相关的话题；没有可追溯指标时不声称搜索量或热门程度。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "xhs-format",
        "dimension": "format",
        "statement": "图文标题、纯文本正文、话题和配图分别交付；按当前产品阈值校验，并在发布器预览确认。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "xhs-links",
        "dimension": "links",
        "statement": "保留必要出处；引用资料与商业站外导流分开检查，不用未经验证的曝光猜测删除证据。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "xhs-visuals",
        "dimension": "visuals",
        "statement": "卡片文字保持清晰可读，图文一致；3:4 是当前卡片设计默认，裁切需最终预览。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      }
    ],
    "conflicts": [
      "社区项目 README 简述标题 20 字；同仓 skill 使用 CJK 权重 2、总长 ≤38，计数口径不同，不能当官方统一规则。"
    ],
    "unknowns": [
      "官方社区公约 2.0 只有搜索索引正文可读，直接页面未提取；涉及 AI 标注及商业交易导流须复核官方页面。",
      "创作后台的标题/正文/图数/大小限制未用当前账号测量；产品阈值不等于最新平台全局限制。",
      "没有本账号真实搜索量、点击率或曝光因果数据。"
    ]
  },
  "x": {
    "platform": "x",
    "revision": "seed-2026-10-22",
    "researchedAt": "2026-10-22T00:00:00.000Z",
    "expiresAt": "2026-10-29T00:00:00.000Z",
    "summary": "标准 API 文本/图片限制有直接官方依据；长帖与回复权限需按账号确认。保留来源，分清费用与曝光猜测。",
    "sources": [
      {
        "id": "x-counting",
        "url": "https://docs.x.com/fundamentals/counting-characters",
        "title": "Counting Characters",
        "publisher": "X",
        "authority": "official",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "标准帖上限为 280 加权字符；普通拉丁字符权重 1，CJK 和 emoji 通常权重 2。 合法 URL 按 23 字符计；使用 NFC Unicode 规范化；官方推荐 twitter-text 处理边界。 标准文本帖计数；不把 Premium 客户端能力推导为当前 API 长帖能力"
      },
      {
        "id": "x-text-config",
        "url": "https://github.com/twitter/twitter-text/blob/master/config/v3.json",
        "title": "twitter-text v3 configuration",
        "publisher": "twitter/twitter-text",
        "authority": "official",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "v3 配置 maxWeightedTweetLength=280，transformedURLLength=23，emojiParsingEnabled=true，显式定义权重范围。 可审计计数实现配置；master 为可变分支，生产应锁定版本"
      },
      {
        "id": "x-pricing",
        "url": "https://docs.x.com/x-api/getting-started/pricing",
        "title": "X API pay-per-usage pricing and credits",
        "publisher": "X",
        "authority": "official",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "当前价目表 Post Create 为每请求 USD 0.015；with URL 为每请求 USD 0.200。 价格可能变动，当前费率以 Developer Console 为准。 该页 pay-per-use API 写请求估算；不涵盖媒体、读取、重试等所有费用；不是曝光规则"
      },
      {
        "id": "x-manage-posts",
        "url": "https://docs.x.com/x-api/posts/manage-tweets/introduction",
        "title": "Manage Posts introduction",
        "publisher": "X",
        "authority": "official",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "一帖支持最多 4 张照片、或 1 个 GIF、或 1 个视频。 当前文档说明 self-serve API 帖子最多 1 个 cashtag，回复须原作者通过提及或引用召唤回复账号。 POST /2/tweets；本次未实发，也未确认自回复 thread 是否存在例外；不要因客户端支持 thread 就宣称该 API 账号串推已验证"
      },
      {
        "id": "x-media",
        "url": "https://docs.x.com/x-api/media/quickstart/best-practices",
        "title": "Media upload best practices",
        "publisher": "X",
        "authority": "official",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "tweet_image 图片上限 5 MB，支持 JPG、PNG、GIF、WEBP。 上传成功与最终发帖通过是独立校验，返回 media_id 不等于必可发布。 原文同时区分 GIF、视频和账号权益；Plume 当前图片发布路径"
      },
      {
        "id": "x-hashtags",
        "url": "https://help.x.com/en/using-x/how-to-use-hashtags",
        "title": "How to use hashtags",
        "publisher": "X",
        "authority": "official",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "标签用于关键词/主题索引，不能包含空格或标点。 官方建议每帖不超过 2 个标签，但明确这不是数量硬上限。 编辑建议与标签语法；不能以 3 个标签为平台拒发理由"
      },
      {
        "id": "x-recommendations",
        "url": "https://help.x.com/en/rules-and-policies/recommendations",
        "title": "Our approach to recommendations",
        "publisher": "X",
        "authority": "official",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "推荐依赖多种兴趣和互动信号；该页说明没有单个信号静态固定为更高权重。 本页没有建立所有外链帖必降曝光的因果规则；未检索到证据不等于证明不存在任何链接相关特征"
      },
      {
        "id": "x-photos",
        "url": "https://help.x.com/en/using-x/posting-gifs-and-pictures",
        "title": "How to post photos or GIFs on X",
        "publisher": "X",
        "authority": "official",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "单图常规比例 2:1 到 3:4 可完整显示。 客户端显示说明；16:9 是我们的封面设计选择，不是平台唯一允许比例"
      },
      {
        "id": "x-long-posts",
        "url": "https://help.x.com/en/using-x/types-of-posts",
        "title": "About different types of Posts",
        "publisher": "X",
        "authority": "official",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "长帖可达 25,000 字符，创建依赖特定付费权益。 客户端/用户产品能力；未验证当前 Plume API connector 的实际长帖权限"
      },
      {
        "id": "x-threads",
        "url": "https://help.x.com/en/using-x/create-a-thread",
        "title": "How to create a thread on X",
        "publisher": "X",
        "authority": "official",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "串推由同一作者连接多帖用于补充背景、更新或展开观点。 客户端时间线里较长串推可能折叠，单帖也可独立分享。 客户端读写行为；首帖自足是由此推导的编辑建议，不是强制格式"
      }
    ],
    "observations": [
      {
        "id": "x-count",
        "dimension": "format",
        "statement": "标准帖按加权字符计算：通常上限 280，CJK 和 emoji 权重 2，合法 URL 为 23；使用 NFC 规范化。",
        "authority": "official",
        "sourceIds": [
          "x-counting"
        ],
        "limitations": "标准帖计数规则；本地近似校验与平台最终识别仍可能有边界差异。"
      },
      {
        "id": "x-photos",
        "dimension": "visuals",
        "statement": "API 单帖最多 4 张照片，单图上限 5 MB；上传成功后仍需发帖接口确认。",
        "authority": "official",
        "sourceIds": [
          "x-media"
        ],
        "limitations": "图片路径；不推导 GIF/视频限制，也不保证当前账号 API 权益。"
      },
      {
        "id": "x-hashtag-guidance",
        "dimension": "tags",
        "statement": "最多 2 个相关标签是官方编辑建议；标签不能含空格或标点。",
        "authority": "official",
        "sourceIds": [
          "x-hashtags"
        ],
        "limitations": "标签数量建议不是硬限制。"
      },
      {
        "id": "x-opening",
        "dimension": "opening",
        "statement": "第一帖单独交代核心发现或观点及必要条件，读者不展开串推也能理解。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "x-structure",
        "dimension": "structure",
        "statement": "优先完整的短帖，复杂论证再分串推，每帖一个重点；排序或 emoji 按作者偏好。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "x-tone",
        "dimension": "tone",
        "statement": "简洁直接，区分事实与观点；压缩措辞时不扩大原稿结论。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "x-api-cost",
        "dimension": "links",
        "statement": "当前 pay-per-use API 普通发帖请求为 USD 0.015，带 URL 请求为 USD 0.200。",
        "authority": "official",
        "sourceIds": [
          "x-pricing"
        ],
        "limitations": "2026-10-22 费用快照，以当前控制台为准；非全成本，不涉及曝光因果。"
      },
      {
        "id": "x-links",
        "dimension": "links",
        "statement": "保留读者判断事实所需的来源链接，不依据未经验证的曝光猜测删除证据。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议；不能由费用推导推荐算法影响。"
      }
    ],
    "conflicts": [],
    "unknowns": [
      "当前 connector 的付费长帖 API 权限未实测；客户端 25,000 字符能力不自动证明 API 可用。",
      "官方 self-serve 回复要求被原作者召唤，自回复串推是否有例外需明确文档或本账号验证。",
      "没有证据能将所有外链帖表述为必然降低曝光。"
    ]
  },
  "wechat_mp": {
    "platform": "wechat_mp",
    "revision": "seed-2026-10-22",
    "researchedAt": "2026-10-22T00:00:00.000Z",
    "expiresAt": "2026-11-05T00:00:00.000Z",
    "summary": "采用完整论证与分节阅读，最终由用户粘贴后台预览。当前资料不把草稿 API 限制等同于手工编辑器能力。",
    "sources": [
      {
        "id": "wechat-draft-official",
        "url": "https://developers.weixin.qq.com/doc/offiaccount/Draft_Box/Add_draft.html",
        "title": "新增草稿（旧官方开发文档）",
        "publisher": "微信",
        "authority": "official",
        "availability": "inaccessible",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "本次抓取失败；不能宣称 32/120/16/20000 数值已被本次官方验证"
      },
      {
        "id": "wechat-wxjava",
        "url": "https://github.com/binarywang/WxJava/blob/develop/weixin-java-mp/src/main/java/me/chanjar/weixin/mp/api/WxMpDraftService.java",
        "title": "WxJava WxMpDraftService.java",
        "publisher": "binarywang/WxJava",
        "authority": "observed",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "该 SDK 注释描述 draft API 的 HTML 内容少于 2 万字符、小于 1 MB，去 JS，正文图片需上传 API 得到 URL，外链图片可能过滤。 API 注释是社区实现的证据，不是手工粘贴编辑器的当前官方限制；HTML 体积与纯文本长度不可混同"
      },
      {
        "id": "wechat-doocs",
        "url": "https://github.com/doocs/md",
        "title": "doocs/md WeChat Markdown Editor",
        "publisher": "doocs",
        "authority": "observed",
        "availability": "read",
        "publishedAt": null,
        "accessedAt": "2026-10-22T00:00:00.000Z",
        "evidence": "项目实现 Markdown 编辑、主题和微信公众号排版流程。 可借鉴预览/HTML 导出/粘贴工作流；不作为微信账号权限或官方调性结论"
      }
    ],
    "observations": [
      {
        "id": "wechat-audience",
        "dimension": "audience",
        "statement": "向明确受众交代问题、背景和必要专业概念，保留证据与适用边界。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "wechat-opening",
        "dimension": "opening",
        "statement": "标题和摘要准确表达文章价值，开头尽早说明为何值得读，避免靠悬念夸大内容。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "wechat-structure",
        "dimension": "structure",
        "statement": "分节展开论点、证据、实例和边界；段落适合手机阅读，结尾给可执行的下一步。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "wechat-tone",
        "dimension": "tone",
        "statement": "完整清楚，有依据地表达作者观点；不强制公文腔，也不照搬短帖式省略。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "wechat-format",
        "dimension": "format",
        "statement": "Markdown 是当前制作输入，最终发布使用富文本 HTML；粘贴后核验标题、摘要、段落、表格、代码及图片。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "wechat-links",
        "dimension": "links",
        "statement": "保留参考资料标题和 URL；链接是否可点击按当前账号和最终编辑器预览确认，不承诺统一权限。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "wechat-visuals",
        "dimension": "visuals",
        "statement": "封面突出主题，在后台预览裁切；2.35:1 是当前设计默认，正文图片需实际插入和检查。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      },
      {
        "id": "wechat-tags",
        "dimension": "tags",
        "statement": "不机械添加其他平台的话题堆叠；关键词自然进入标题、摘要与正文。",
        "authority": "editorial",
        "sourceIds": [],
        "limitations": "Ruyix 编辑建议，可按本账号评分调整；不是平台硬限制或流量保证。"
      }
    ],
    "conflicts": [],
    "unknowns": [
      "本次官方草稿 API 文档不可访问；旧数值不标成新近官方验证。",
      "SDK 的 HTML 长度/体积及图片上传契约仅描述 API，不证明手工粘贴编辑器的当前阈值。",
      "当前账号外链、封面和编辑器能力需用户最终预览确认。"
    ]
  }
}
