// The platforms a post goes to: each one's limits (with whether it was verified and where it came from), the guide an
// agent writes that platform's version to, the fields of that version, and the check that runs on it — after it is
// written (one round of fixing on what fails), when the person edits it, and before it is published. Ported from Plume
// (server/platforms): 小红书, X, 公众号. A person overrides a limit in the pack's settings (`limits.<platform>.<key>`)
// once it is measured on a real account.

const seg = new Intl.Segmenter('zh', { granularity: 'grapheme' })
/** Characters as a person counts them: an emoji (several code points) is one. */
export const charCount = s => [...seg.segment(String(s ?? ''))].length
export const str = v => (typeof v === 'string' ? v : '')
export const strs = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
const URL_RE = /\bhttps?:\/\/[^\s)）\]】"'<>]+|\b(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|ai|dev|co|app|me|xyz|tv)(?:\/[^\s)）\]】"'<>]*)?/gi
export const hasUrl = s => new RegExp(URL_RE.source, 'i').test(String(s ?? ''))

// X counts a post's length by weight (twitter-text v3): Latin and common punctuation 1, everything else (CJK) 2, an
// emoji 2, a link 23 whatever its length.
const LIGHT = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]]
const EMOJI = /\p{Extended_Pictographic}/u
export function weighted(text) {
  let n = 0
  const rest = String(text ?? '').replace(new RegExp(URL_RE.source, 'gi'), () => { n += 23; return '' })
  for (const { segment } of seg.segment(rest)) {
    if (EMOJI.test(segment)) { n += 2; continue }
    for (const ch of segment) { const c = ch.codePointAt(0); n += LIGHT.some(([a, b]) => c >= a && c <= b) ? 1 : 2 }
  }
  return n
}

const CHECKED_AT = '2026-10-22'
const SRC_MCP = 'https://github.com/xpzouying/xiaohongshu-mcp (2026-10-22; community implementation, not official)'
const SRC_3P = { en: 'Plume product default; platform/account limit not verified', zh: 'Plume 产品默认值；平台与当前账号限制未验证' }
const SRC_X_TEXT = 'https://docs.x.com/fundamentals/counting-characters (2026-10-22)'
const SRC_X_MEDIA = 'https://docs.x.com/x-api/media/quickstart/best-practices (2026-10-22)'
const SRC_X_PRICE = 'https://docs.x.com/x-api/getting-started/pricing (2026-10-22; pay-per-use, subject to change)'
const SRC_MP = { en: 'Plume default; https://developers.weixin.qq.com/doc/offiaccount/Draft_Box/Add_draft.html unavailable on 2026-10-22; manual editor not measured', zh: 'Plume 默认值；https://developers.weixin.qq.com/doc/offiaccount/Draft_Box/Add_draft.html 于 2026-10-22 未能读取，人工编辑器未实测' }
const L = (en, zh) => ({ en, zh })
const issue = (level, code, en, zh, field) => ({ level, code, ...(field && { field }), en, zh })
const ratio = i => (i?.width && i?.height ? i.width / i.height : 0)

export const PLATFORMS = {
  xhs: {
    id: 'xhs', name: L('Xiaohongshu', '小红书'), mode: 'browser', creator: 'https://creator.xiaohongshu.com/publish/publish?source=official',
    limits: [
      { key: 'titleMax', label: L('Title, characters at most', '标题字数上限'), value: 20, verified: false, source: SRC_MCP },
      { key: 'bodyMax', label: L('Body with topics, characters at most', '正文（含话题）字数上限'), value: 1000, verified: false, source: SRC_MCP },
      { key: 'imagesMax', label: L('Images at most', '图片上限'), value: 18, verified: false, source: SRC_3P },
      { key: 'imagesSafe', label: L('Images, product review threshold', '图片数量复核阈值（产品设置）'), value: 9, verified: false, source: SRC_3P },
      { key: 'imageSizeMb', label: L('One image, MB at most', '单张图片大小上限（MB）'), value: 20, verified: false, source: SRC_3P },
      { key: 'tagsMax', label: L('Topics, suggested at most', '建议话题数上限'), value: 10, verified: false, source: L('rule of thumb', '经验值') },
    ],
    template: { title: '', body: '', tags: [], cover: { title: '', subtitle: '' }, cards: [{ heading: '', points: [] }] },
    guide: l => `平台：小红书图文笔记。字段：title（标题）、body（正文，纯文本，不含话题）、tags（话题，不带 #）、cover（封面卡片 { title, subtitle }）、cards（内页卡片 [{ heading, points[] }]）。
- 当前产品标题上限 ${l.titleMax} 字；标题、封面与正文一致，用具体信息说明价值，不夸大承诺。
- 当前产品正文含话题上限 ${l.bodyMax} 字，建议预留话题空间；短段落，开头点明读者问题；正文交付纯文本，表情与段落长短是编辑选择。
- 话题不带 # 号，按内容相关性选择，建议不超过 ${l.tagsMax} 个；没有实际指标时不要声称搜索量、热度或曝光收益。
- 封面卡片：大字标题 ≤ 14 字，副标题一句话。
- 内页卡片 2–6 张，每张一个小标题 + 2–5 条短要点（每条 ≤ 30 字），读者只看卡片也能获得核心信息；要点里可以用 **重点** 标出要高亮的词。
- 保留必要的事实出处，区分资料引用与商业站外交易导流；链接能力需在当前发布器预览核验，不以未经证实的曝光猜测删掉来源。
- 上述结构、口吻和卡片数量是可调整的编辑建议，数值是当前产品校验设置；保留原稿的事实、证据和适用条件，不虚构亲测经历。`,
    title: f => str(f.title),
    check(f, images, l) {
      const out = []
      const title = str(f.title), body = str(f.body), tags = strs(f.tags)
      if (!title) out.push(issue('error', 'title.empty', 'The title is empty', '标题为空', 'title'))
      else if (charCount(title) > l.titleMax) out.push(issue('error', 'title.max', `The title has ${charCount(title)} characters, more than ${l.titleMax}`, `标题 ${charCount(title)} 字，超过 ${l.titleMax} 字`, 'title'))
      if (!body.trim()) out.push(issue('error', 'body.empty', 'The body is empty', '正文为空', 'body'))
      const len = charCount(body) + tags.reduce((n, t) => n + charCount(t) + 2, 0)
      if (len > l.bodyMax) out.push(issue('error', 'body.max', `The body with its topics is about ${len} characters, more than ${l.bodyMax}`, `正文连同话题约 ${len} 字，超过 ${l.bodyMax} 字`, 'body'))
      if (tags.length > l.tagsMax) out.push(issue('warning', 'tags.max', `${tags.length} topics; at most ${l.tagsMax} is better`, `话题 ${tags.length} 个，建议不超过 ${l.tagsMax} 个`, 'tags'))
      if (hasUrl(body)) out.push(issue('warning', 'body.link', 'The body has a link: verify how the creator editor handles it, and distinguish a source citation from off-platform sales', '正文含链接：请在创作后台确认呈现方式，并区分资料引用与站外交易导流', 'body'))
      if (!images.length) out.push(issue('error', 'images.empty', 'An image note needs at least one image', '图文笔记至少需要 1 张图片'))
      if (images.length > l.imagesMax) out.push(issue('error', 'images.max', `${images.length} images, more than ${l.imagesMax}`, `图片 ${images.length} 张，超过 ${l.imagesMax} 张`))
      else if (images.length > l.imagesSafe) out.push(issue('warning', 'images.safe', `${images.length} images: whether the limit is ${l.imagesSafe} or ${l.imagesMax} is not measured yet`, `图片 ${images.length} 张；上限是 ${l.imagesSafe} 还是 ${l.imagesMax} 张尚未实测`))
      for (const i of images) if (i.size > l.imageSizeMb * 1048576) out.push(issue('error', 'image.size', `${i.name} is over ${l.imageSizeMb} MB`, `${i.name} 超过 ${l.imageSizeMb}MB`))
      if (new Set(images.filter(ratio).map(i => ratio(i).toFixed(2))).size > 1) out.push(issue('warning', 'images.ratio.mixed', 'The images have different shapes: inspect the final crop in the creator editor', '图片比例不一致：请在创作后台检查最终裁切'))
      if (images[0] && ratio(images[0]) && Math.abs(ratio(images[0]) - 3 / 4) > 0.02) out.push(issue('info', 'images.ratio', 'The first image differs from Plume’s 3:4 card default; check readability and crop', '首图与 Plume 的 3:4 卡片默认比例不同，请检查可读性与裁切'))
      return out
    },
  },
  x: {
    id: 'x', name: L('X', 'X'), mode: 'api', creator: 'https://x.com/compose/post',
    limits: [
      { key: 'tweetMax', label: L('One post, weighted characters at most (CJK 2, a link 23)', '单帖加权字符上限（中日韩字符算 2，链接算 23）'), value: 280, verified: true, source: SRC_X_TEXT, checkedAt: CHECKED_AT },
      { key: 'premiumMax', label: L('One post with Premium (whether the API takes it: not measured)', '付费会员单帖上限（接口是否支持待实测）'), value: 25000, verified: false, source: 'https://help.x.com/en/using-x/types-of-posts (2026-10-22; client entitlement documented, this API path not measured)' },
      { key: 'imagesMax', label: L('Images per post at most', '每帖图片上限'), value: 4, verified: true, source: SRC_X_MEDIA, checkedAt: CHECKED_AT },
      { key: 'imageSizeMb', label: L('One image, MB at most', '单张图片大小上限（MB）'), value: 5, verified: true, source: SRC_X_MEDIA, checkedAt: CHECKED_AT },
      { key: 'postCostUsd', label: L('A post costs (USD)', '发帖单价（美元/条）'), value: 0.015, verified: true, source: SRC_X_PRICE, checkedAt: CHECKED_AT },
      { key: 'linkPostCostUsd', label: L('A post with a link costs (USD)', '带链接的帖子单价（美元/条）'), value: 0.2, verified: true, source: SRC_X_PRICE, checkedAt: CHECKED_AT },
    ],
    template: { tweets: [''] },
    guide: (l, s) => `平台：X（Twitter）。字段：tweets（帖子列表：1 条 = 单帖，多条 = 串推，按顺序发布）。
- 优先写成单帖；内容确实需要展开时写成串推，2–6 条，第一条必须单独成立、能抓住人。
- 单条长度按加权字符计：英文字母算 1，中日韩字符算 2，链接固定算 23；每条不超过 ${s?.x?.premium ? l.premiumMax : l.tweetMax}。中文单条大约不超过 ${Math.floor((s?.x?.premium ? l.premiumMax : l.tweetMax) / 2) - 10} 字。
- 保留必要来源链接。当前 pay-per-use API 估算每个带 URL 的发帖请求 $${l.linkPostCostUsd}、普通请求 $${l.postCostUsd}；默认费率核验于 ${CHECKED_AT}，以最新控制台为准，不含所有附加费用。费用不能推导曝光变化。
- 官方建议每帖不超过 2 个相关话题标签，并非硬上限；本发布路径交付纯文本。串推编号、表情与长短按作者偏好，确保每条承接清楚。
- 结构与调性是编辑建议；保持事实、来源与限制。API 长帖及回复权限需当前账号支持，不能仅凭客户端能力推定。`,
    title: f => strs(f.tweets)[0]?.slice(0, 40) || '',
    check(f, images, l, s) {
      const out = []
      const tweets = strs(f.tweets), max = s?.x?.premium ? l.premiumMax : l.tweetMax
      if (!tweets.length) out.push(issue('error', 'tweets.empty', 'No post', '没有内容', 'tweets'))
      let cost = 0
      tweets.forEach((t, i) => {
        const n = weighted(t)
        if (!t.trim()) out.push(issue('error', 'tweet.empty', `Post ${i + 1} is empty`, `第 ${i + 1} 条为空`, `tweets.${i}`))
        if (n > max) out.push(issue('error', 'tweet.max', `Post ${i + 1}: ${n} weighted characters, more than ${max}`, `第 ${i + 1} 条 ${n} 加权字符，超过 ${max}`, `tweets.${i}`))
        else if (n > l.tweetMax) out.push(issue('warning', 'tweet.premium', `Post ${i + 1} is longer than ${l.tweetMax}: it needs Premium, and whether the API takes it is not measured`, `第 ${i + 1} 条超过 ${l.tweetMax}，依赖付费会员长帖；接口是否支持待实测`, `tweets.${i}`))
        if (hasUrl(t)) { cost += l.linkPostCostUsd; out.push(issue('warning', 'tweet.link', `Post ${i + 1} has a link: estimated API write cost $${l.linkPostCostUsd}; verify the current rate in Developer Console`, `第 ${i + 1} 条含链接：估算 API 写请求费用 $${l.linkPostCostUsd}，请核对当前控制台费率`, `tweets.${i}`)) } else cost += l.postCostUsd
      })
      if (images.length > l.imagesMax) out.push(issue('error', 'images.max', `${images.length} images; a post takes ${l.imagesMax} at most`, `图片 ${images.length} 张，每帖最多 ${l.imagesMax} 张`))
      for (const i of images) if (i.size > l.imageSizeMb * 1048576) out.push(issue('error', 'image.size', `${i.name} is over ${l.imageSizeMb} MB`, `${i.name} 超过 ${l.imageSizeMb}MB`))
      if (tweets.length) out.push(issue('info', 'cost', `Estimated Post create cost $${cost.toFixed(3)}; default rates checked ${CHECKED_AT}, other charges may apply`, `预计发帖请求费用 $${cost.toFixed(3)}；默认费率核验于 ${CHECKED_AT}，不含其他费用`))
      return out
    },
  },
  wechat_mp: {
    id: 'wechat_mp', name: L('WeChat Official Account', '公众号'), mode: 'manual', creator: 'https://mp.weixin.qq.com/',
    limits: [
      { key: 'titleMax', label: L('Title, product limit (verify in the editor)', '标题产品上限（需在编辑器核验）'), value: 64, verified: false, source: SRC_MP },
      { key: 'titleApiMax', label: L('Title, draft API reference (not verified for this route)', '标题草稿接口参考值（本路径未验证）'), value: 32, verified: false, source: SRC_MP },
      { key: 'digestMax', label: L('Summary, characters at most', '摘要字数上限'), value: 120, verified: false, source: SRC_MP },
      { key: 'authorMax', label: L('Author, characters at most', '作者字数上限'), value: 16, verified: false, source: SRC_MP },
      { key: 'bodyMax', label: L('Body, product character limit', '正文产品字符上限'), value: 20000, verified: false, source: SRC_MP },
    ],
    template: { title: '', digest: '', author: '', body: '' },
    guide: l => `平台：微信公众号文章。字段：title（标题）、digest（摘要）、author（作者，可留空）、body（正文 Markdown）。
- 标题 ≤ 30 字，信息量足、不做标题党；摘要 ≤ ${l.digestMax} 字，一句话说清读者能得到什么。
- 正文用 Markdown：用 ## 二级标题分 3–6 节，段落短，关键句加粗；篇幅 1500–3000 字。
- 开头三句话内交代「为什么值得读」；结尾给一个总结或可执行的下一步。
- 保留引用来源，在文末列出参考资料标题和网址；链接可点击性按当前账号及后台预览确认，不假定所有账号权限相同。
- 不要放图片占位符，配图由作者另行插入；Markdown 是制作输入，最终复制富文本并在后台预览标题、换行、链接与裁切。
- 结构、篇幅与语气是编辑建议，数值是当前产品校验设置，草稿 API 参考值不代表人工编辑器的当前限制；保留事实与适用边界。`,
    title: f => str(f.title),
    check(f, images, l) {
      const out = []
      const title = str(f.title), digest = str(f.digest), author = str(f.author), body = str(f.body)
      if (!title) out.push(issue('error', 'title.empty', 'The title is empty', '标题为空', 'title'))
      else if (charCount(title) > l.titleMax) out.push(issue('error', 'title.max', `The title has ${charCount(title)} characters, more than ${l.titleMax}`, `标题 ${charCount(title)} 字，超过 ${l.titleMax} 字`, 'title'))
      else if (charCount(title) > l.titleApiMax) out.push(issue('info', 'title.api', `The title exceeds the draft API reference value ${l.titleApiMax}; this manual route must be checked in the current editor`, `标题超过草稿接口参考值 ${l.titleApiMax} 字；当前人工发布路径需在编辑器核验`, 'title'))
      if (charCount(digest) > l.digestMax) out.push(issue('error', 'digest.max', `The summary has ${charCount(digest)} characters, more than ${l.digestMax}`, `摘要 ${charCount(digest)} 字，超过 ${l.digestMax} 字`, 'digest'))
      if (charCount(author) > l.authorMax) out.push(issue('error', 'author.max', `The author "${author}" is longer than ${l.authorMax}`, `作者「${author}」超过 ${l.authorMax} 字`, 'author'))
      if (!body.trim()) out.push(issue('error', 'body.empty', 'The body is empty', '正文为空', 'body'))
      if (body.length > l.bodyMax) out.push(issue('error', 'body.max', `The body has ${body.length} characters, more than ${l.bodyMax}`, `正文 ${body.length} 字符，超过 ${l.bodyMax}`, 'body'))
      if (/\]\(https?:\/\//.test(body)) out.push(issue('warning', 'body.link', 'The body has links: verify clickability in the current account’s editor and preserve source URLs in References', '正文含超链接：请在当前账号编辑器确认可点击性，并在参考资料保留来源网址', 'body'))
      const cover = images[0]
      if (!cover) out.push(issue('warning', 'cover.empty', 'No cover image (Plume’s layout default is 2.35:1, e.g. 900×383)', '没有封面图（Plume 排版默认比例为 2.35:1，如 900×383）'))
      else if (ratio(cover) && Math.abs(ratio(cover) - 2.35) > 0.1) out.push(issue('info', 'cover.ratio', 'The cover differs from Plume’s 2.35:1 default: inspect the crop in the editor', '封面与 Plume 的 2.35:1 默认比例不同，请在后台检查裁切'))
      return out
    },
  },
}
export const PLATFORM_IDS = Object.keys(PLATFORMS)

/** A platform's limits as they stand: its defaults with the person's measured values over them. → { key: value } */
export const limitsOf = (id, settings) => Object.fromEntries(PLATFORMS[id].limits.map(l => [l.key, Number(settings?.limits?.[id]?.[l.key] ?? l.value)]))

/** A platform's version, as an agent or a person handed it in, made to its fields (missing ones empty, the wrong kind left out). */
export function fieldsOf(id, raw) {
  const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (id === 'xhs') {
    const cover = f.cover && typeof f.cover === 'object' ? f.cover : {}
    const cards = (Array.isArray(f.cards) ? f.cards : []).filter(c => c && typeof c === 'object').slice(0, 17).map(c => ({ heading: str(c.heading), points: strs(c.points).slice(0, 8) }))
    return { title: str(f.title), body: str(f.body), tags: strs(f.tags).map(t => t.replace(/^#+/, '').trim()).filter(Boolean).slice(0, 20), cover: { title: str(cover.title), subtitle: str(cover.subtitle) }, cards }
  }
  if (id === 'x') return { tweets: strs(f.tweets).slice(0, 25) }
  if (id === 'wechat_mp') return { title: str(f.title), digest: str(f.digest), author: str(f.author), body: str(f.body ?? f.bodyMd) }
  throw new Error(`unknown platform ${id}`)
}

/** Check a platform's version: [{ level: error | warning | info, code, field?, en, zh }]. images: [{ name, size, width, height }]. */
export const check = (id, fields, images, settings) => PLATFORMS[id].check(fieldsOf(id, fields), images || [], limitsOf(id, settings), settings || {})
export const errorsOf = issues => issues.filter(i => i.level === 'error')
/** Issues editable in the shared post review. Attachment limits are enforced per platform at publication. */
export const textIssues = issues => issues.filter(i => !/^(images?|cover|cost)\b/.test(i.code))
