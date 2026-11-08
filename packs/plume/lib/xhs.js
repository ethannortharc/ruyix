// 小红书: the connection type that keeps the creator site's session (a QR sign-in in the workbench's visible browser),
// and the publish flow — open the creator site in a browser the person watches, upload the images, fill in the title,
// the body and the topics, and stop: the person checks it and clicks 发布 themselves. A step that does not work (the
// site changed) stops there with a screenshot; what is filled stays, and the person does the rest in the same view.
// Selectors: xpzouying/xiaohongshu-mcp xiaohongshu/publish.go (2026-10-09, Apache-2.0), by way of Plume.

export const XHS = {
  home: 'https://creator.xiaohongshu.com/new/home',
  login: 'https://creator.xiaohongshu.com/login',
  publishUrl: 'https://creator.xiaohongshu.com/publish/publish?source=official',
  loginUrlPattern: /\/login/,
  publishFormPattern: /\/publish\/publish/,
  uploadArea: 'div.upload-content',
  tab: 'div.creator-tab',
  tabImageText: '上传图文',
  popover: 'div.d-popover',
  firstImageInput: '.upload-input',
  fileInput: 'input[type="file"]',
  uploadedPreview: '.img-preview-area .pr',
  titleInput: 'div.d-input input',
  bodyEditors: ['div[role="textbox"][contenteditable="true"]', 'div.tiptap[contenteditable="true"]', 'div.ql-editor'],
  featureGuideButton: '.feature-guide__btn',
  topicSuggestion: '#creator-editor-topic-container .item',
  titleTooLong: 'div.title-container div.max_suffix',
  bodyTooLong: 'div.edit-container div.length-error',
  successText: /发布成功/,
}

/** The cookies a browser keeps, as the session slot holds them (what a new browser needs to be signed in again). */
export const keepCookies = cookies => JSON.stringify((cookies || []).filter(c => /xiaohongshu\.com$/.test(String(c.domain || '').replace(/^\./, ''))).map(c => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path, ...(c.expires > 0 && { expires: c.expires }), httpOnly: !!c.httpOnly, secure: !!c.secure, ...(c.sameSite && { sameSite: c.sameSite }),
})))
const header = json => { try { return JSON.parse(json).map(c => `${c.name}=${c.value}`).join('; ') } catch { return '' } }

/** The connector type `xhs` (the connectors plugin's registerType). */
export const xhsType = {
  label: { en: 'Xiaohongshu creator', zh: '小红书创作服务平台' },
  blurb: { en: 'Publish image notes: sign in by scanning the QR code with the Xiaohongshu app', zh: '发布图文笔记：用小红书 App 扫码登录' },
  baseUrl: { required: false, default: 'https://creator.xiaohongshu.com', example: 'https://creator.xiaohongshu.com' },
  hosts: ['creator.xiaohongshu.com', 'edith.xiaohongshu.com', 'www.xiaohongshu.com'],
  fields: [],
  slots: [{ name: 'session', label: { en: 'Signed-in session', zh: '登录会话' }, hint: { en: 'Made by signing in (scan the QR code)', zh: '扫码登录后自动生成' }, level: 'write', required: true, auto: true }],
  headers: token => (token ? { cookie: header(token) } : {}),
  slotFor: () => 'session',
  signin: {
    slot: 'session',
    label: { en: 'Sign in (scan)', zh: '扫码登录' },
    url: () => XHS.login,
    // signed in: the site left its login page for the creator's own pages, with its cookies set
    ready: (url, cookies) => /creator\.xiaohongshu\.com/.test(url) && !XHS.loginUrlPattern.test(url) && cookies.length > 2,
    keep: cookies => ({ slots: { session: keepCookies(cookies) }, fields: {} }),
  },
  async test(c) {
    const res = await c.request('/new/home', { redirect: 'manual', headers: { accept: 'text/html' } })
    const to = res.headers.get('location') || ''
    if (res.status >= 300 && res.status < 400 && /login/.test(to)) return { ok: false, detail: 'the session has ended: sign in again (scan)' }
    return res.ok || res.status < 400 ? { ok: true, detail: 'signed in' } : { ok: false, detail: `HTTP ${res.status}` }
  },
  // the session is a browser's only: never a command's environment (a script step could send it anywhere) — a plugin's
  // own browser asks the connectors for it (`browserCookies`, audited)
  env: () => ({}),
  cookies: (conn, s) => { try { return JSON.parse(s.session || '[]') } catch { return [] } },
  howTo: () => 'https://creator.xiaohongshu.com/',
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const jitter = (a, b) => sleep(a + Math.random() * (b - a))
async function typeLikeHuman(page, text) { for (const ch of String(text)) { await page.keyboard.type(ch); await jitter(40, 130) } }
async function insertParagraphs(page, text) {
  const lines = String(text).split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.insertText(lines[i])
    if (i < lines.length - 1) await page.keyboard.press('Enter')
    await jitter(100, 300)
  }
}
async function firstVisible(page, selectors, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
    for (const s of selectors) { const l = page.locator(s).first(); if (await l.isVisible().catch(() => false)) return l }
  }
  return null
}

/**
 * Fill the note in: page (Playwright's, signed in), { title, body, tags, images: [paths] }, say(step text) for the person
 * watching. → { filled: [step names], stoppedAt?, error?, warnings[] }; throws `needLogin` when the session has ended.
 */
export async function fillNote(page, { title, body, tags = [], images = [] }, say = () => {}) {
  say('打开发布页')
  await page.goto(XHS.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(1500)
  if (XHS.loginUrlPattern.test(page.url())) throw Object.assign(new Error('the 小红书 session has ended: sign in again on the Connectors page (scan)'), { code: 'needLogin' })
  const steps = [
    ['切换到「上传图文」', async () => {
      await page.locator(XHS.uploadArea).first().waitFor({ state: 'visible', timeout: 20000 })
      for (let i = 0; i < 10; i++) {
        if (await page.locator(XHS.popover).first().isVisible().catch(() => false)) await page.keyboard.press('Escape')
        try { await page.locator(XHS.tab, { hasText: XHS.tabImageText }).first().click({ timeout: 2000 }); return } catch { await sleep(500) }
      }
      throw new Error('找不到或点不到「上传图文」')
    }],
    [`上传 ${images.length} 张图片`, async () => {
      for (let i = 0; i < images.length; i++) {
        say(`上传第 ${i + 1}/${images.length} 张图片`)
        const input = i === 0 ? page.locator(XHS.firstImageInput).first() : page.locator(`${XHS.fileInput}[accept*="image"], ${XHS.fileInput}`).first()
        await input.setInputFiles(images[i])
        for (const end = Date.now() + 60000; (await page.locator(XHS.uploadedPreview).count()) < i + 1; await sleep(500)) if (Date.now() > end) throw new Error(`第 ${i + 1} 张图片上传超时`)
        await jitter(300, 800)
      }
    }],
    ['填写标题', async () => {
      const input = page.locator(XHS.titleInput).first()
      await input.waitFor({ state: 'visible', timeout: 15000 })
      await input.click()
      await typeLikeHuman(page, title)
    }],
    ['填写正文', async () => {
      const editor = await firstVisible(page, XHS.bodyEditors)
      if (!editor) throw new Error('找不到正文编辑器')
      await editor.click()
      await insertParagraphs(page, body)
    }],
    ['添加话题', async () => {
      await page.locator(XHS.featureGuideButton).first().click({ timeout: 1000 }).catch(() => {})
      for (const tag of tags) {
        await page.keyboard.type('#'); await sleep(200)
        await typeLikeHuman(page, String(tag).replace(/^#/, '')); await sleep(1000)
        const item = page.locator(XHS.topicSuggestion).first()
        if (await item.isVisible().catch(() => false)) { await item.click(); await sleep(500) } else await page.keyboard.type(' ')
      }
    }],
  ]
  const filled = []
  for (const [name, run] of steps) {
    say(name)
    try { await run(); filled.push(name); await jitter(300, 700) } catch (err) {
      return { filled, stoppedAt: name, error: String(err?.message || err).slice(0, 300), warnings: [] }
    }
  }
  const warnings = []
  if (await page.locator(XHS.titleTooLong).first().isVisible().catch(() => false)) warnings.push('平台提示标题超长')
  if (await page.locator(XHS.bodyTooLong).first().isVisible().catch(() => false)) warnings.push('平台提示正文超长')
  say('')
  return { filled, warnings }
}

/** Published: the site says so — its success page, or its own words on the page (a page left, a click on 后退, is not). */
export async function published(page) {
  if (/\/publish\/success/.test(page.url())) return true
  return XHS.successText.test(await page.locator('body').innerText({ timeout: 1000 }).catch(() => ''))
}
