// The built-in connector types: how one kind of service is reached (an adapter registers its own the same way:
// connectors.registerType). A type names its fields (not secret), its credential slots
// (secret; each used at one level), the request headers a slot becomes, the hosts a connection may reach, a test, and —
// for the command-line tools — the variables a command gets. A connection is one instance of a type (connections.json).
//
// Levels: `read` changes nothing; `write` changes shared state (needs an approval).
//
// A type that signs in by OAuth 2.0 carries `oauth` (its tokens expire: the service refreshes them before a request) and a
// `signin` with `begin` / `intercept` (the browser is sent to the site's authorize page and the redirect back is caught).

import { createHash, randomBytes } from 'node:crypto'

const L = (en, zh) => ({ en, zh })
const json = async res => res.json().catch(() => null)
const days = d => Math.floor((Date.parse(d) - Date.now()) / 864e5)
const fail = (res, slot) => ({ ok: false, detail: res.status === 401 ? `HTTP 401 — the ${slot} is wrong, expired or revoked` : `HTTP ${res.status}` })

/** A kubeconfig without its clusters' CA (kubectl then trusts the system's, in a box the gateway's): the line in block
 * style, the entry in flow style (`cluster: { server: "…", certificate-authority-data: "…" }`). */
const CA_ENTRY = String.raw`certificate-authority(?:-data)?:[ \t]*(?:"[^"]*"|'[^']*'|[^\s,}]+)`
const noClusterCa = text => text
  .replace(/^[ \t]*certificate-authority(?:-data)?:.*\r?\n/gm, '')
  .replace(new RegExp(`,[ \\t]*${CA_ENTRY}`, 'g'), '')
  .replace(new RegExp(`${CA_ENTRY}[ \\t]*,[ \\t]*`, 'g'), '')
  .replace(new RegExp(CA_ENTRY, 'g'), '')

export const TYPES = {
  gitlab: {
    label: L('GitLab', 'GitLab'),
    blurb: L('Merge requests, pipelines, the code', '合并请求、流水线、代码'),
    baseUrl: { required: true, example: 'https://gitlab.example.com' },
    fields: [],
    slots: [
      { name: 'read', label: L('Read token', '读 token'), hint: L('A personal access token with read_api', '有 read_api 的个人访问令牌'), level: 'read', required: true },
      { name: 'write', label: L('Write token', '写 token'), hint: L('With the "api" scope: opening, commenting on and approving MRs, pushing', '有 api scope：开 MR、评论、approve、推送'), level: 'write' },
    ],
    headers: token => ({ 'private-token': token }),
    /** Each token set: who, its scopes, its expiry; the write token needs "api". */
    async test(c) {
      const out = []
      let expiresIn = null
      for (const slot of ['read', 'write'].filter(s => c.has(s))) {
        const res = await c.request('/api/v4/personal_access_tokens/self', { slot })
        if (!res.ok) return fail(res, `${slot} token`)
        const t = await json(res), scopes = t?.scopes || []
        if (slot === 'write' && !scopes.includes('api')) return { ok: false, detail: `the write token has ${scopes.join(', ')} — writing needs the "api" scope` }
        if (t?.expires_at) { const left = days(t.expires_at); expiresIn = expiresIn == null ? left : Math.min(expiresIn, left) }
        out.push(`${slot}: ${scopes.join(', ')}${t?.expires_at ? ` · expires ${t.expires_at}` : ''}`)
      }
      const user = await c.request('/api/v4/user').then(r => (r.ok ? json(r) : null), () => null)
      return { ok: true, detail: `${user?.username ? `@${user.username} · ` : ''}${out.join(' · ')}`, ...(expiresIn != null && { expiresIn }) }
    },
    env: (conn, s) => ({ GITLAB_URL: conn.baseUrl, ...(s.read && { GITLAB_TOKEN: s.read }), ...(s.write && { GITLAB_WRITE_TOKEN: s.write }) }),
    howTo: conn => `${conn.baseUrl}/-/user_settings/personal_access_tokens`,
  },

  k8s: {
    label: L('Kubernetes', 'Kubernetes'),
    blurb: L('A cluster through a kubeconfig: workloads, logs, deploys', '用 kubeconfig 连集群：工作负载、日志、部署'),
    baseUrl: { required: false, from: 'kubeconfig' }, // the API server, read from the kubeconfig
    fields: [{ name: 'namespace', label: L('Namespace', '命名空间'), required: true }],
    slots: [{ name: 'kubeconfig', label: L('Kubeconfig', 'Kubeconfig'), hint: L('Least privilege: a service account\'s kubeconfig', '最小权限：用服务账号的 kubeconfig'), level: 'read', required: true, file: true,
      // block style (`token: …` on its own line) and flow style (`user: { token: "…" }`) alike; `id-token:` is not one
      vaulted: { secrets: /((?:^|[\s{,])token:[ \t]*["']?)([^\s"',}#]+)/gm, trust: noClusterCa } }],
    // kubectl reads its own file: the service writes the slot to a private file per use (service.file). In a box whose
    // policy trusts the cluster's CA (`nookbox update <box> --trust <API host>=ca.pem`) the token goes to the host's
    // vault like any header credential, and kubectl trusts the box's CA (the gateway's) instead of the cluster's
    async test(c) {
      const r = await c.kubectl(['-n', c.conn.fields.namespace, 'get', 'deployments', '-o', 'name', '--request-timeout=10s'])
      return r.code === 0 ? { ok: true, detail: `${r.stdout.trim().split('\n').filter(Boolean).length} deployments in ${c.conn.fields.namespace}` } : { ok: false, detail: lastLine(r) }
    },
    env: (conn, s, { file }) => ({ KUBECONFIG: file('kubeconfig') }),
  },

  http: {
    label: L('HTTP API', 'HTTP API'),
    blurb: L('Any HTTP service: an API, Jenkins, OpenBao…', '任意 HTTP 服务：API、Jenkins、OpenBao……'),
    baseUrl: { required: true, example: 'https://api.example.com/v2' },
    fields: [
      { name: 'auth', label: L('Authentication', '认证方式'), options: ['header', 'bearer', 'basic', 'cookie', 'none'], default: 'header' },
      { name: 'header', label: L('Header', '请求头'), default: 'authorization', when: { auth: 'header' } },
      { name: 'template', label: L('Header value', '请求头的值'), hint: L('{token} is replaced, e.g. "ApiKey {token}"', '{token} 会被替换，例如 "ApiKey {token}"'), default: '{token}', when: { auth: 'header' } },
      { name: 'signinUrl', label: L('Sign-in page', '登录页'), hint: L('Where the browser sign-in opens; the address above when empty', '浏览器登录从这里打开；留空则用上面的地址'), default: '', when: { auth: 'cookie' } },
      { name: 'testPath', label: L('Test path', '测试路径'), hint: L('GET this to test the connection', '用 GET 测试连接'), default: '' },
    ],
    slots: [
      { name: 'token', label: L('Token', 'Token'), level: 'read' },
      { name: 'user', label: L('User', '用户名'), level: 'read', plain: true },
      { name: 'password', label: L('Password', '密码'), level: 'read' },
    ],
    headers(token, conn, s) {
      const f = conn.fields
      if (f.auth === 'bearer') return token ? { authorization: `Bearer ${token}` } : {}
      if (f.auth === 'basic') return s.user ? { authorization: `Basic ${Buffer.from(`${s.user}:${s.password || ''}`).toString('base64')}` } : {}
      if (f.auth === 'cookie') return token ? { cookie: token } : {}
      if (f.auth === 'none') return {}
      return token ? { [f.header || 'authorization']: String(f.template || '{token}').replaceAll('{token}', token) } : {}
    },
    slotFor: () => 'token',
    // A site with no API token (SAML, a QR code…): sign in in a browser on the machine dsh runs on, then confirm; the
    // cookies the browser holds for the address become the token (auth "cookie"). Any type may carry one.
    signin: {
      slot: 'token',
      manual: true,
      applies: fields => fields.auth === 'cookie',
      url: conn => conn.fields.signinUrl || conn.baseUrl,
      ready: () => false,
      keep: cookies => ({ slots: { token: cookies.map(c => `${c.name}=${c.value}`).join('; ') }, fields: {} }),
    },
    async test(c) {
      if (!c.conn.fields.testPath) return { ok: true, detail: 'no test path set' }
      const res = await c.request(c.conn.fields.testPath)
      return res.ok ? { ok: true, detail: `GET ${c.conn.fields.testPath} → ${res.status}` } : fail(res, 'token')
    },
    env: (conn, s) => ({ API_URL: conn.baseUrl, ...(s.token && { API_TOKEN: s.token }), ...(s.user && { API_USER: s.user }), ...(s.password && { API_PASSWORD: s.password }) }),
  },
}

// --- X (OAuth 2.0 authorization code + PKCE; the tokens expire and are refreshed with the refresh token) ---

const b64url = b => b.toString('base64url')
const X_SCOPES = 'tweet.read tweet.write users.read media.write offline.access'
const X_ENDPOINTS = { authorize: 'https://x.com/i/oauth2/authorize', token: 'https://api.x.com/2/oauth2/token', api: 'https://api.x.com/2' }
const hide = (text, values) => values.filter(v => typeof v === 'string' && v.length >= 6).reduce((t, v) => t.split(v).join('«secret»'), String(text ?? ''))

/** The token endpoint's request: a confidential client (it has a secret) uses Basic authentication, a public one sends only its id. */
function tokenRequest(url, { clientId, clientSecret }, params) {
  return {
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(clientSecret && { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` }) },
    body: new URLSearchParams({ ...params, client_id: clientId }).toString(),
  }
}
/** What the token endpoint answered, as slot values (a refresh token is not always sent again: '' keeps the old); null: no token in it. */
const tokensOf = (json, at) => (json?.access_token ? { access: String(json.access_token), refresh: json.refresh_token ? String(json.refresh_token) : '', expiresAt: String(at + (Number(json.expires_in) || 7200) * 1000) } : null)
/** Why the token endpoint said no: its status and its two error words — nothing else of the answer. */
const why = (status, json) => `HTTP ${status}${json?.error ? `: ${String(json.error).slice(0, 80)}` : ''}${json?.error_description ? ` (${String(json.error_description).slice(0, 200)})` : ''}`

/** The `x` type; endpoints can be pointed elsewhere (the self-check registers one against a fake server). */
export function xType(endpoints = {}) {
  const e = { ...X_ENDPOINTS, ...endpoints }
  return {
    label: L('X', 'X'),
    blurb: L('Post, thread and upload images through the X API (OAuth 2.0)', '通过 X 接口（OAuth 2.0）发帖、串推、上传图片'),
    baseUrl: { required: false, default: e.api, example: X_ENDPOINTS.api },
    hosts: ['api.x.com'],
    fields: [
      { name: 'clientId', label: L('Client ID', 'Client ID'), required: true, hint: L('developer.x.com → your app → Keys and tokens → OAuth 2.0 Client ID', 'developer.x.com → 你的应用 → Keys and tokens → OAuth 2.0 Client ID') },
      { name: 'redirectUri', label: L('Callback address', '回调地址'), default: 'http://127.0.0.1:4310/api/oauth/x/callback', hint: L('Must be exactly the callback address registered in the X app (the default is the one Plume registered: one app serves both)', '必须和 X 应用里登记的回调地址一字不差（默认值是 Plume 登记过的那个，同一个应用两边都能用）') },
    ],
    slots: [
      { name: 'clientSecret', label: L('Client secret', 'Client secret'), hint: L('Only a confidential client has one; without it the app is a public client', '只有 confidential client 才有；没有就按 public client 处理'), level: 'write' },
      { name: 'access', label: L('Access token', '访问令牌'), hint: L('Made by "Connect X"', '由「连接 X」生成'), level: 'write', required: true, auto: true },
      { name: 'refresh', label: L('Refresh token', '刷新令牌'), hint: L('Made by "Connect X"', '由「连接 X」生成'), level: 'write', auto: true },
      { name: 'expiresAt', label: L('Expires at', '过期时间'), hint: L('Milliseconds since 1970; kept up to date by Connect X and by refreshing', '毫秒时间戳；由「连接 X」和自动刷新维护'), level: 'write', plain: true, auto: true },
    ],
    headers: token => ({ authorization: `Bearer ${token}` }),
    slotFor: () => 'access',
    // the service refreshes before a request when `expiresAt` is near (and once for requests that come together)
    oauth: {
      access: 'access', refresh: 'refresh', expiresAt: 'expiresAt',
      refreshRequest: (conn, s) => tokenRequest(e.token, { clientId: conn.fields.clientId, clientSecret: s.clientSecret }, { grant_type: 'refresh_token', refresh_token: s.refresh }),
      tokens: tokensOf,
      why,
    },
    signin: {
      slot: 'access',
      label: L('Connect X', '连接 X'),
      /** The authorize page to open, and the sign-in's private state (kept by the service, handed back to `ready` and `keep`). */
      begin(conn, values) {
        const verifier = b64url(randomBytes(32)), state = b64url(randomBytes(16))
        const { clientId, redirectUri } = conn.fields
        const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: X_SCOPES, state, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' })
        return { url: `${e.authorize}?${q}`, state: { state, verifier, clientId, redirectUri, clientSecret: values.clientSecret || '' } }
      },
      intercept: conn => conn.fields.redirectUri,
      ready: (url, cookies, base, extra) => !!extra?.callbackUrl,
      /** Trade the code from the callback for tokens. Errors say what went wrong and hold no token. */
      async keep(cookies, html, { callbackUrl, state }) {
        const q = new URL(callbackUrl).searchParams, code = q.get('code') || ''
        const gone = text => hide(text, [state.clientSecret, state.verifier, code])
        if (q.get('error')) throw new Error(gone(`X did not authorize: ${q.get('error')}${q.get('error_description') ? ` (${q.get('error_description').slice(0, 200)})` : ''}`))
        if (q.get('state') !== state.state) throw new Error('the callback does not belong to this sign-in (the state differs): connect X again')
        if (!code) throw new Error('the callback has no authorization code: connect X again')
        const req = tokenRequest(e.token, state, { grant_type: 'authorization_code', code, redirect_uri: state.redirectUri, code_verifier: state.verifier })
        const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(30000) })
          .catch(err => { throw new Error(gone(`X's token endpoint could not be reached: ${err.cause?.message || err.message}`)) })
        const json = await res.json().catch(() => null)
        if (!res.ok || !json?.access_token) throw new Error(gone(`X's token endpoint refused the code — ${why(res.status, json)}`))
        const t = tokensOf(json, Date.now())
        return { slots: { access: t.access, ...(t.refresh && { refresh: t.refresh }), expiresAt: t.expiresAt }, fields: {} }
      },
    },
    async test(c) {
      const res = await c.request('/users/me')
      if (res.status === 401) return { ok: false, detail: 'HTTP 401 — X refused the access token: reconnect X (Connect X on this card)' }
      if (!res.ok) return fail(res, 'access token')
      const me = await json(res)
      return { ok: true, detail: me?.data?.username ? `@${me.data.username}` : 'connected' }
    },
    env: (conn, s, { write } = {}) => ({ X_API_URL: conn.baseUrl, ...(write && s.access && { X_ACCESS_TOKEN: s.access }) }),
    howTo: () => 'https://developer.x.com/en/portal/dashboard',
  }
}

TYPES.x = xType()

// --- 123 云盘 (123pan open platform): its own client id and secret buy an access token (no sign-in); used to share files ---

const PAN123_API = 'https://open-api.123pan.com'
/** The `pan123` type; the API's address can be pointed elsewhere (the self-check uses a fake one). */
export function pan123Type(api = PAN123_API) {
  const host = new URL(api).hostname
  return {
    label: L('123 Cloud Drive', '123 云盘'),
    blurb: L('Upload files and make share links (123pan open platform: client ID and secret)', '上传文件、生成分享链接（123 云盘开放平台：client ID 和 secret）'),
    baseUrl: { required: false, default: api, example: PAN123_API },
    hosts: [host],
    shareTarget: 'pan123', // lib/share.js: files in, a share link out
    fields: [{ name: 'clientId', label: L('Client ID', 'Client ID'), required: true, hint: L('Sent as a site message after buying 123pan\'s developer package', '在 123 云盘购买「开发者权益包」后，以站内信发给你') }],
    slots: [
      { name: 'clientSecret', label: L('Client secret', 'Client secret'), level: 'write', required: true },
      { name: 'access', label: L('Access token', '访问令牌'), hint: L('Fetched with the client ID and secret, renewed before it runs out', '用 client ID 和 secret 换来，快过期时自动换新'), level: 'write', auto: true },
      { name: 'expiresAt', label: L('Expires at', '过期时间'), level: 'write', plain: true, auto: true },
    ],
    // every call carries the platform's header besides the token
    headers: token => ({ ...(token && { authorization: `Bearer ${token}` }), platform: 'open_platform' }),
    slotFor: () => 'access',
    oauth: {
      access: 'access', expiresAt: 'expiresAt', clientCredentials: true,
      refreshRequest: (conn, s) => (s.clientSecret ? { url: `${conn.baseUrl.replace(/\/$/, '')}/api/v1/access_token`, headers: { 'content-type': 'application/json', platform: 'open_platform' }, body: JSON.stringify({ clientID: conn.fields.clientId, clientSecret: s.clientSecret }) } : null),
      // { code: 0, data: { accessToken, expiredAt } } — anything else is a refusal
      tokens: (json, at) => (json?.code === 0 && json.data?.accessToken ? { access: String(json.data.accessToken), refresh: '', expiresAt: String(Date.parse(json.data.expiredAt) || at + 7 * 864e5) } : null),
      why: (status, json) => `HTTP ${status}${json?.code ? ` · code ${json.code}` : ''}${json?.message ? `: ${String(json.message).slice(0, 160)}` : ''}`,
    },
    async test(c) {
      const res = await c.request('/api/v1/user/info')
      const body = await json(res)
      if (!res.ok || body?.code !== 0) return { ok: false, detail: `HTTP ${res.status}${body?.message ? ` · ${String(body.message).slice(0, 120)}` : ''}` }
      return { ok: true, detail: `${body.data?.nickname || 'signed in'} · uid ${body.data?.uid ?? '?'}` }
    },
  }
}
TYPES.pan123 = pan123Type()

/**
 * The `baidupan` type (百度网盘开放平台): signed in by scanning a code with the Baidu Netdisk app (OAuth device code: the
 * app key and secret key of the person's own application), the access token in each request's query string (the platform
 * wants it there), renewed with the refresh token. Files go up into the application's own folder (/apps/<app name>/ —
 * 「我的应用数据」 in the app); any of the person's files can be listed and downloaded. Share links through the API are an
 * enterprise developer's paid service (lib/drive.js tries, and says so when it is not there). The addresses can be pointed
 * elsewhere (the self-check uses a fake one).
 */
export function baidupanType({ pan = 'https://pan.baidu.com', pcs = 'https://d.pcs.baidu.com', oauth = 'https://openapi.baidu.com' } = {}) {
  const host = u => new URL(u).hostname
  const token = (conn, s, params) => ({ url: `${oauth}/oauth/2.0/token?${new URLSearchParams({ ...params, client_id: conn.fields.appKey, client_secret: s.secretKey || '' })}`, method: 'GET', headers: {} })
  // { access_token, refresh_token, expires_in } — anything else is a refusal
  const tokens = (j, at) => (j?.access_token ? { access: String(j.access_token), refresh: String(j.refresh_token || ''), expiresAt: String(at + (Number(j.expires_in) || 2592000) * 1000) } : null)
  return {
    label: L('Baidu Netdisk', '百度网盘'),
    blurb: L('Upload and download files in batches (your own app on pan.baidu.com/union: app key and secret key; sign in by scanning a code)', '批量上传、下载文件（在 pan.baidu.com/union 建一个自己的应用：AppKey 和 SecretKey；用百度网盘 App 扫码授权）'),
    baseUrl: { required: false, default: pan, example: 'https://pan.baidu.com' },
    hosts: [...new Set([host(pan), host(pcs), host(oauth)])],
    endpoints: { pan, pcs, oauth },
    shareTarget: 'baidupan', // lib/share.js
    drive: 'baidupan', // lib/drive.js: list, upload, download
    fields: [
      { name: 'appKey', label: L('App key', 'AppKey'), required: true, hint: L('pan.baidu.com/union → console → your app', 'pan.baidu.com/union → 控制台 → 你的应用') },
      { name: 'appName', label: L('App name', '应用名称'), required: true, hint: L('As created: uploads go to /apps/<app name>/ (我的应用数据)', '建应用时填的名称：上传的文件放在「我的应用数据/应用名称」') },
      { name: 'appId', label: L('App ID', 'AppID'), hint: L('Only for share links (an enterprise service)', '只有生成分享链接要用（企业开发者的服务）') },
    ],
    slots: [
      { name: 'secretKey', label: L('Secret key', 'SecretKey'), level: 'write', required: true },
      { name: 'access', label: L('Access token', '访问令牌'), hint: L('From scanning the code; renewed before it runs out (30 days)', '扫码授权得到；到期前自动换新（30 天）'), level: 'write', auto: true, device: true },
      { name: 'refresh', label: L('Refresh token', '刷新令牌'), level: 'write', auto: true },
      { name: 'expiresAt', label: L('Expires at', '过期时间'), level: 'write', plain: true, auto: true },
    ],
    // the platform takes the token in the query string, not in a header
    query: t => (t ? { access_token: t } : {}),
    headers: () => ({}),
    slotFor: () => 'access',
    oauth: {
      access: 'access', refresh: 'refresh', expiresAt: 'expiresAt',
      refreshRequest: (conn, s) => (s.refresh ? token(conn, s, { grant_type: 'refresh_token', refresh_token: s.refresh }) : null),
      tokens,
      why: (status, j) => `HTTP ${status}${j?.error ? ` · ${j.error}` : ''}${j?.error_description ? `: ${String(j.error_description).slice(0, 160)}` : ''}`,
    },
    // OAuth device code: a code to scan (or type in), then the token once the person agrees
    device: {
      start: conn => ({ url: `${oauth}/oauth/2.0/device/code?${new URLSearchParams({ response_type: 'device_code', client_id: conn.fields.appKey, scope: 'basic,netdisk' })}` }),
      code: j => (j?.device_code ? { device: String(j.device_code), userCode: String(j.user_code || ''), verifyUrl: String(j.verification_url || ''), qrcodeUrl: String(j.qrcode_url || ''), expiresIn: Number(j.expires_in) || 300, interval: Math.max(5, Number(j.interval) || 5) } : null),
      poll: (conn, s, device) => token(conn, s, { grant_type: 'device_token', code: device }),
      pending: j => ['authorization_pending', 'slow_down'].includes(j?.error),
      tokens,
      why: (status, j) => `HTTP ${status}${j?.error ? ` · ${j.error}` : ''}${j?.error_description ? `: ${String(j.error_description).slice(0, 160)}` : ''}`,
    },
    async test(c) {
      if (!c.has('access')) return { ok: false, detail: 'not signed in yet: scan the code (扫码授权)' }
      const res = await c.request('/rest/2.0/xpan/nas?method=uinfo')
      const body = await json(res)
      if (!res.ok || body?.errno !== 0) return { ok: false, detail: `HTTP ${res.status}${body?.errno !== undefined ? ` · errno ${body.errno}` : ''}${body?.errmsg ? ` · ${String(body.errmsg).slice(0, 120)}` : ''}` }
      const vip = ['普通用户', '会员', '超级会员'][Number(body.vip_type)] || ''
      return { ok: true, detail: `${body.netdisk_name || body.baidu_name || 'signed in'}${vip ? ` · ${vip}` : ''}` }
    },
  }
}
TYPES.baidupan = baidupanType()

const lastLine = r => (r.stderr || r.stdout || '').trim().split('\n').at(-1)?.slice(0, 300) || `exit ${r.code}`

/** The slot a request of `level` uses: the type's choice, else the first slot of that level that is set (write falls back to nothing). */
export function slotFor(type, level, has) {
  if (type.slotFor) return type.slotFor(level)
  const at = type.slots.filter(s => s.level === level && !s.plain && !s.file)
  return at.find(s => has(s.name))?.name || at[0]?.name || null
}

/** A connection's field values with the type's defaults. */
export const fieldsOf = (type, fields = {}) => Object.fromEntries(type.fields.map(f => [f.name, fields[f.name] ?? f.default ?? '']))
