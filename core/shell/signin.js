// The page a browser that is not signed in gets instead of dsh's one line of plain text. Signing in stays dsh's own: the
// workbench's sign-in link (`ruyix link` on its machine) carries a token that dsh exchanges for a cookie on this address,
// so the page only takes the link (or the bare token) and opens ./?token=… here.
import { MARK_SVG } from './mark.js'

const TEXT = {
  en: {
    title: 'Sign in · Ruyix',
    heading: 'Sign in',
    lead: 'This browser is not signed in yet. Open this workbench’s sign-in link once and the browser stays signed in for 30 days.',
    label: 'Sign-in link',
    placeholder: 'http://…/?token=…  (or just the token)',
    submit: 'Sign in',
    empty: 'Paste the sign-in link, or the token in it.',
    failed: 'That link no longer opens this workbench: it changes every time the workbench restarts. Get the current one with ruyix link.',
    whereTitle: 'Where is the link?',
    whereOwn: 'On the machine that runs the workbench, run {cmd}.',
    other: '中文',
  },
  zh: {
    title: '登录 · Ruyix',
    heading: '登录',
    lead: '这个浏览器还没有登录。打开一次这个工作台的登录链接，之后这个浏览器 30 天内都保持登录。',
    label: '登录链接',
    placeholder: 'http://…/?token=…（也可以只粘贴 token）',
    submit: '登录',
    empty: '请粘贴登录链接，或者链接里的 token。',
    failed: '这个链接已经打不开这个工作台了：工作台每次重启都会换一个新链接。用 ruyix link 获取当前的链接。',
    whereTitle: '链接在哪里？',
    whereOwn: '在运行工作台的那台机器上执行 {cmd}。',
    other: 'English',
  },
}

/** The language: ?lang= when given, else the browser's first choice. */
export function pickLang(url, acceptLanguage = '') {
  const asked = url.searchParams.get('lang')
  if (asked === 'zh' || asked === 'en') return asked
  return /^\s*zh/i.test(acceptLanguage) ? 'zh' : 'en'
}

/** The sign-in page; `failed` when the request carried a token dsh refused. */
export function signinPage({ lang = 'en', failed = false } = {}) {
  const t = TEXT[lang] || TEXT.en
  const icon = `data:image/svg+xml,${encodeURIComponent(MARK_SVG)}`
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${t.title}</title>
<link rel="icon" href="${icon}">
<style>
:root { --bg: #f5f5f4; --card: #fff; --text: #1c1c1e; --muted: #6b6b70; --line: #e2e2e5; --well: #f2f2f4; --btn: #18181b; --btn-text: #fff; --warn-bg: #fdf3e7; --warn: #8a4b08; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #111113; --card: #1b1b1e; --text: #ececee; --muted: #9a9aa2; --line: #2e2e33; --well: #232327; --btn: #ececee; --btn-text: #111113; --warn-bg: #3a2a14; --warn: #f3c58a; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--text);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { width: 100%; max-width: 420px; }
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; font-size: 15px; font-weight: 500; letter-spacing: -.01em; }
.brand img { width: 28px; height: 28px; }
.brand b { font-weight: 650; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
h1 { margin: 0 0 6px; font-size: 20px; font-weight: 650; letter-spacing: -.01em; }
p { margin: 0; color: var(--muted); }
form { margin-top: 20px; display: grid; gap: 8px; }
label { font-weight: 600; font-size: 13px; }
input { width: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--well); color: var(--text); font: inherit; }
input:focus { outline: 2px solid var(--muted); outline-offset: 1px; }
button { margin-top: 4px; padding: 9px 14px; border: 0; border-radius: 8px; background: var(--btn); color: var(--btn-text); font: inherit; font-weight: 600; cursor: pointer; }
.note { margin-top: 14px; padding: 9px 11px; border-radius: 8px; background: var(--warn-bg); color: var(--warn); font-size: 13px; }
.note[hidden] { display: none; }
.where { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
.where b { display: block; margin-bottom: 4px; color: var(--text); font-weight: 600; }
code { padding: 1px 6px; border-radius: 6px; background: var(--well); color: var(--text); font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
.lang { margin-top: 14px; text-align: right; font-size: 12px; }
.lang a { color: var(--muted); }
</style>
</head>
<body>
<main>
  <div class="brand"><img src="${icon}" alt=""><span><b>Ruyix</b></span></div>
  <div class="card">
    <h1>${t.heading}</h1>
    <p>${t.lead}</p>
    <div class="note" id="note"${failed ? '' : ' hidden'}>${failed ? t.failed : ''}</div>
    <form id="form">
      <label for="link">${t.label}</label>
      <input id="link" name="link" autocomplete="off" spellcheck="false" placeholder="${t.placeholder}" autofocus>
      <button type="submit">${t.submit}</button>
    </form>
    <div class="where"><b>${t.whereTitle}</b>${t.whereOwn.replace('{cmd}', '<code>ruyix link</code>')}</div>
  </div>
  <div class="lang"><a href="./?lang=${lang === 'zh' ? 'en' : 'zh'}">${t.other}</a></div>
</main>
<script>
document.getElementById('form').addEventListener('submit', function (e) {
  e.preventDefault()
  var v = document.getElementById('link').value.trim(), token = v
  try { token = new URL(v).searchParams.get('token') || '' } catch (_) { /* a bare token */ }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    var note = document.getElementById('note')
    note.textContent = ${JSON.stringify(t.empty)}
    note.hidden = false
    return
  }
  location.href = './?token=' + encodeURIComponent(token)
})
</script>
</body>
</html>
`
}
