# @ruyix/connectors

Every service ruyix reaches, as a connection: GitLab, a Kubernetes cluster (`k8s`), any HTTP API (`http`: Jenkins,
OpenBao, a site you sign in to…), X (`x`: OAuth 2.0), 123 云盘 (`pan123`: its client ID and secret buy the token) and 百度网盘
(`baidupan`: the person's own app on pan.baidu.com/union — app key, app name, secret key — signed in by scanning a code with
the Baidu Netdisk app: OAuth device code; the token goes in the query string, the platform's way).

- A **connection** is data without secrets: `~/.ruyix/connectors/connections.json` (id, type, address, fields, hosts).
- Its **credentials** are in dsh's credential store, one record `connectors/<id>` per connection. The page shows only
  whether each is set.
- The products name the connections they use (`service.require`) and reach them only through the service:
  `client(id).request(path, { level })` adds the credential (a JSON body, or a form / bytes as they are; the answer as `json()`, `text()` or `bytes()`) (the write token only for `level: 'write'`), reaches only
  the connection's hosts and takes any credential out of what comes back; `env(id)` gives a command its variables;
  `file(id, slot)` a private copy of a kubeconfig or key; `kubectl`; `command` for a type that ships its own program.
- Every call is recorded in `~/.ruyix/connectors/audit.jsonl`: method, path, status, time, by whom — never content.
- **Sign-in** (a site with no API token): a browser on the machine dsh runs on, shown in the page; the session is kept.
  An `http` connection with authentication "cookie" offers it: sign in, press "I'm signed in", and the cookies the
  browser holds for the address become the token. Any type can carry one (`signin: { ready, keep }`).
- **OAuth 2.0** (`x`): "Connect X" opens X's authorize page in that browser and catches the redirect to the callback
  address (the address is never requested; the code goes to the type's `keep`, which trades it for tokens). The tokens
  expire: a type with `oauth` has its access token refreshed by the service before a request (once for requests that come
  together; the refresh is audited as `REFRESH`; when it fails the error is `reconnect`). In a nookbox box these slots
  stay in the box — a refresh needs the real refresh token — and none goes in a configuration file.
- `ruyix config import` leaves `~/.ruyix/connectors/import.json`; the plugin takes it at its next start.

**Signing in by a code** (OAuth device code): a type with `device` (`start`, `code`, `poll`, `pending`, `tokens`) and a
slot marked `device` gets a "扫码授权" button: `deviceStart(id)` asks the site for a code and returns it with its picture
(fetched here, as data; the device code stays in the service), `devicePoll(id)` asks whether the person agreed and keeps
the tokens. A type with `query(token)` has its credential put into each request's query string (never into the audit or
the address shown); a `refreshRequest` may say its `method`.

**Drives** (`lib/drive.js`): a type with `drive` keeps files — `driveList(id, path)`, `driveFiles(id, path)` (every file
under a folder, with its place in it), `driveUpload(id, files, folder)` and `driveDownload(id, items, dir)` (in batches; a
file already there with the same size is kept; the bytes come from the address the drive hands out, without the
credential, audited as GET). `baidupan`: uploads in 4 MB slices into the app's own folder (`/apps/<app name>/`, 我的应用数据
in the app — the platform allows no other place), any of the person's files listed and downloaded (`filemetas` → the link
→ the redirect, with the platform's user agent). Packs reach the service through the workbench (`connectors()`).

**Share targets** (`lib/share.js`): a type with `shareTarget` takes files and gives back a link others open —
`service.share(id, [{ path, name }], { folder, expireDays, password, by })` → `{ url, password, expireDays, folder, files }`.
`pan123` puts the files into `Ruyix/<folder>` on the drive and makes a share link (and its code); the token goes only to the
open platform's host, the bytes go to the presigned upload addresses the drive hands out (no credential on them, audited as
`PUT`). A type without a refresh token whose own credentials buy it says `oauth.clientCredentials` (fetched when there is none).
Packs call it from an approved action (the video pack's 选片分享).

The Connectors page (sidebar → Admin) adds, edits, tests and signs in; every AI session gets `connectors_list` and
`connectors_test` (never a value).

`node check.mjs` — the self-check (a fake service on loopback).
