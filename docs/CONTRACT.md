# chromium-claude-profiles: build contract

Status: binding for all implementers. Scope cut: §6 (kanban) and `import-cswap`/`cswap.ts`/`CSWAP_BIN` are out of scope for v0.1 — do not build them.

Original status line: If anything here turns out to be wrong when you test it, stop and report it. Do not work around it quietly.

## 0a. v0.3: one Chromium for every account (supersedes the per-profile model where they disagree)

The user keeps one main Chromium, with one login per site to maintain. Every Claude account lives there as a cookie jar (§5.3), and agents drive it through the launcher instead of starting a browser per account.

- **No new browsers.** `ccp launch <account>` never starts an old per-account profile or a new `--user-data-dir`. It switches the main Chromium's claude.ai account through the extension and opens the URL there. If the main Chromium is not running it starts the binary plain (no flags), which opens the default profile, and waits up to 20 s for the extension to connect.
- **The bridge (§4.11).** The extension keeps a native messaging port open (`chrome.runtime.connectNative`), which also keeps its service worker alive. The host started for that port listens on a unix socket in `CCP_HOME/run/` (0700): `main.sock` when the parent browser is the main Chromium (`current === null`), `profile-<name>.sock` when it is an old profile. The CLI sends one newline-terminated JSON request per connection and reads one JSON line back. Filesystem permissions are the authentication: only the user's own processes, an agent over ssh as that user included, can connect. No debugging port is opened.
- **Limit, stated plainly.** Chromium cookies are per profile, not per tab, so one claude.ai account is active in the whole browser at a time. A switch reloads every claude.ai tab into the new account. Concurrent agents asking for different accounts take turns; the last switch wins. Per-tab accounts (rewriting the cookie header per tab) are not built: claude.ai's frontend reads non-HttpOnly cookies such as `lastActiveOrg` from the shared store, which would mix accounts within a tab. A second window of the same profile shares the same store, so it gives no second account either.
- **Claude in Chrome** keeps one login in the main Chromium, so only Claude Code on that account pairs with it. Agents on other accounts use `ccp` to switch and open, and other means (screen control) to see the page.
- **Migration (§4.12).** `ccp migrate` reads each old profile's live session through that profile's own extension and imports it into the main Chromium. Cookies cross the bridge sockets and the `ccp` process's memory for this alone, and are never printed, logged or returned.
- **Rollout (`scripts/pilot-migrate.sh`).** One idempotent shell script moves a Mac onto this model, with `--dry-run` reading only: fast-forward the checkout to `origin/main`, link `~/.local/bin/ccp`, `ccp install-host --chromium-default`, check the extension is loaded in the main profile (its id in `Secure Preferences` or `Preferences`) and answers `main.sock`, else stop with exit 3 and the hand step, then `ccp migrate`, then `SIGTERM` each old profile browser whose args carry `--user-data-dir=<CCP_HOME>/profiles/<name>`, keeping any whose outcome was `unreachable`, then `ccp status`. It never uses sudo, never quits the main Chromium, never signs out, never deletes a profile folder and never prints a cookie. Loading the unpacked extension into the main Chromium stays a hand step: Chromium installs one only from `chrome://extensions` or a `--load-extension` restart, and restarting the main Chromium is ruled out.
- **`ccp switch <account>`** is `ccp launch <account>` with no URL.
- **Expiry (§5.3).** Each jar reports `sessionExpiresAt`, the `sessionKey` cookie's expiry; `accounts.json` in `CCP_HOME` carries every account's state for monitors.

## 0. The premise, corrected by the research

- **What pairs Claude in Chrome with Claude Code is the claude.ai account, not the native host.** Claude Code 2.1.292 always uses the cloud bridge. Both sides join `wss://bridge.claudeusercontent.com/chrome/<accountUuid>`. The native host socket `/tmp/claude-mcp-browser-bridge-$USER/<pid>.sock` is not on the pairing path.
  - So "multiple instances of Claude in Chrome" means **one Chromium `--user-data-dir` per Claude account**. Claude in Chrome in profile *i* is signed into account *i*, and Claude Code for that account runs with `CLAUDE_CONFIG_DIR=<config dir i>`.
  - No wrapper, socket or environment trick on the native host changes which account a browser pairs with. Do not build one.
- **Swapping claude.ai cookies inside one profile switches only the claude.ai web session.** It does not change the account Claude in Chrome pairs with, because Claude in Chrome keeps its own identity in extension storage. The cookie-jar feature is kept, but it is scoped and labelled as "claude.ai tab account" and must never be described as switching Claude in Chrome.
- **Native messaging host manifests are looked up per `--user-data-dir`.** This was tested: the default `~/Library/Application Support/Chromium/NativeMessagingHosts` is not consulted. The launcher therefore writes host manifests into every profile it manages.
- **`--load-extension` works in Chromium 155.0.8059.39.** An unpacked copy of Claude in Chrome keeps its id `fcoeoabgfenejglbffodgkkbkcdhcgfn` because its manifest has a `key`. One vendored copy can serve every profile, and nothing has to be installed from the Web Store per profile.

## 1. Repository layout and ownership

Each builder writes only inside the directories it owns.

```
chromium-claude-profiles/
  README.md                      (launcher builder: usage section only)
  docs/CONTRACT.md               (architect)
  launcher/                      (LAUNCHER builder)
    bin/ccp
    src/cli.ts
    src/paths.ts
    src/store.ts
    src/running.ts
    src/chromium.ts
    src/claudeExt.ts
    src/hostManifest.ts
    src/nativeHost.ts
    src/protocol.ts
    src/server.ts
    src/token.ts
    src/cswap.ts
    src/claudeInChrome.ts
    src/relogin.ts
  launcher/test/                 (TESTS builder)
    store.test.ts  running.test.ts  chromium.test.ts  claudeExt.test.ts
    nativeHost.test.ts  server.test.ts  protocol.test.ts  hostManifest.test.ts
    relogin.test.ts
  tests/e2e/smoke.ts             (TESTS builder)
  extension/                     (EXTENSION builder)
    manifest.json
    service-worker.js
    popup.html  popup.css  popup.js
    lib/protocol.js  lib/native.js  lib/jars.js
    test/jars.test.js
  (kanban changes live in ~/workspace/kanban)   (KANBAN builder)
```

Run every test with `node --test 'launcher/test/*.test.ts' 'extension/test/*.test.js'`. There is no npm, no dependencies and no build step.

## 2. Naming and fixed constants (no employer names anywhere)

| Constant | Value |
|---|---|
| Native host name | `engineer.cute.claude_profiles` |
| Our extension id | `bkgjdpakjigjgdggfcckikppbjjcdkim` |
| Our manifest `key` | see §5.1 (public key committed; no private key exists) |
| Claude in Chrome id | `fcoeoabgfenejglbffodgkkbkcdhcgfn` |
| Claude Code host name | `com.anthropic.claude_code_browser_extension` |
| HTTP port | `47321` on `127.0.0.1` (override `--port` / `CCP_PORT`) |
| Version | `0.1.0` (`ping` and `/v1/health` report it) |
| Profile name regex | `^[a-z0-9][a-z0-9-]{0,31}$` |

**Extension id strategy.** I generated an RSA-2048 keypair once, put the SPKI DER public key in base64 in `manifest.json` as `key`, and discarded the private key. A private key is needed only to pack a `.crx`, and we never pack one: the extension is always loaded unpacked through `--load-extension`. The id is derived from the key, so it is fixed and can be hard-coded in `allowed_origins`.

The derivation is `sha256(DER)`, then the first 32 hex characters, each mapped to the letters a–p. Both values were produced with Node `crypto`. The tests verify that the key hashes to the id.

## 3. Environment overrides (used by tests; defaults in brackets)

| Variable | Meaning |
|---|---|
| `CCP_HOME` | State root. [`~/.config/chromium-claude-profiles`] |
| `CCP_CHROMIUM` | Chromium binary. [`/Applications/Chromium.app/Contents/MacOS/Chromium`] |
| `CCP_CLAUDE_EXT_SOURCE` | Directory that holds the Claude in Chrome version folders. [`~/Library/Application Support/Chromium/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn`] Read only, never written. |
| `CCP_EXTENSION_DIR` | Our extension. [`<repo>/extension`, resolved from `import.meta.url`] |
| `CCP_EXTRA_ARGS` | Extra Chromium flags, split on whitespace. The e2e test uses it for `--headless=new --remote-debugging-port=0`. |
| `CCP_PORT` | Port for `serve`. |
| `CCP_CLAUDE` | Claude Code binary that drives "sign back in" (§4.10). [`/opt/homebrew/bin/claude`] |
| `CCP_DRIVER_DIRS` | Colon-separated parent directories; every subdirectory is a candidate Claude Code config dir for driving "sign back in" (§4.10). [none] |
| `CSWAP_BIN` | cswap binary for `import-cswap`. [`cswap`] |

## 4. launcher/

### 4.1 Runtime rules

- Node 24 type stripping, with no flags and no `tsc`. The syntax limits that follow from this:
  - no `enum`, no `namespace`, no parameter properties;
  - `import type` for types only;
  - every relative import carries its `.ts` extension.
- Zero dependencies; only `node:*` modules.
- **stdout belongs to the protocol in `native-host` mode.** All diagnostics go to `process.stderr`, so there are no `console.log` calls outside `cli.ts` output paths.
- **Never log, print or return cookie values, tokens or OAuth data.**

`launcher/bin/ccp` (mode 0755):

```sh
#!/bin/sh
dir=$(cd "$(dirname "$0")/.." && pwd -P)
node=${CCP_NODE:-$(command -v node)}
exec "$node" --disable-warning=ExperimentalWarning "$dir/src/cli.ts" "$@"
```

`bin/ccp` must also work through a symlink, for example `~/.local/bin/ccp`. To support that, resolve `$0` with `readlink` in a loop before calling `dirname`.

### 4.2 State on disk (`CCP_HOME`)

```
profiles.json                 {"schemaVersion":1,"profiles":[Profile...]}  (atomic write: tmp + rename, mode 0600)
token                         64 hex chars, mode 0600, created on first `serve`
bin/native-host               wrapper (0755), see 4.6
vendor/claude-in-chrome/<versionDir>/   verbatim copy of Claude in Chrome
profiles/<name>/              Chromium --user-data-dir
profiles/<name>/NativeMessagingHosts/engineer.cute.claude_profiles.json
profiles/<name>/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json  (copied, see 4.6)
relogin.json                  mailboxes for "sign back in" (§4.10); written by the user, only read by ccp
logs/relogin-<iso>.log        output of each "sign back in" run (dir 0700, file 0600)
logs/relogin-<browser>.pid    process group of the browser's running "sign back in" driver (0600); <browser> is main or profile-<name>
run/main.sock                 bridge to the main Chromium's extension (§4.11), 0600, in a 0700 directory
run/profile-<name>.sock       bridge to an old profile's extension, for migration only
accounts.json                 {"schemaVersion":1,"updatedAt","accounts":[{name,label,email,status,checkedAt,sessionExpiresAt,state}]} (0600), written from the main browser's reports
```

Set the `CCP_HOME` directory itself to mode 0700.

### 4.3 Types (`protocol.ts` is canonical; `extension/lib/protocol.js` mirrors it)

```ts
export type Profile = { name: string; email: string | null; configDir: string | null; createdAt: string };
export type ProfileView = Profile & { userDataDir: string; running: boolean; pid: number | null };
export type ErrorCode =
  | "invalid_request" | "not_found" | "already_exists" | "running"
  | "unauthorized" | "chromium_not_found" | "unsupported" | "native_host_unavailable" | "internal";
export type Failure = { ok: false; error: { code: ErrorCode; message: string } };
export type Result<T extends object> = ({ ok: true } & T) | Failure;
```

`email` is unique across profiles, compared case-insensitively. Two profiles on the same account land on the same bridge channel, and then Claude Code stops to ask which browser to use. `add` therefore rejects a duplicate email with `already_exists`.

### 4.4 Requests: one dispatcher shared by CLI, HTTP and native host

`protocol.ts` exports `handle(req: unknown, ctx: { home: string; env: NodeJS.ProcessEnv; current: string | null }): Promise<Result<...>>`. The request envelope is `{ "type": string, ...params }`.

| type | params | success body |
|---|---|---|
| `ping` | – | `{ok:true, version:"0.1.0"}` |
| `profiles.list` | – | `{ok:true, profiles: ProfileView[], current: string \| null}` |
| `profiles.status` | `{name}` | `{ok:true, profile: ProfileView}` |
| `profiles.add` | `{name, email?, configDir?}` | `{ok:true, profile: ProfileView}` |
| `profiles.remove` | `{name, keepData?: boolean}` | `{ok:true}` |
| `profiles.launch`, `accounts.open` | `{name, url?}` | `{ok:true, label, email, switched: boolean, reloadedTabs, tabId, account: AccountView, startedBrowser: boolean}` — switches the main Chromium, never starts an old profile |
| `accounts.list` | – | `{ok:true, browser:{connected, updatedAt}, active: label \| null, accounts: AccountView[]}`; falls back to `accounts.json` with `connected:false` |
| `accounts.status` | `{name?}` | as `accounts.list` after checking every jar, or `{…, account: AccountView}` for one |
| `accounts.openFor` | `{url}` | `{ok:true, label, email, tabId, tried:[{label, result}], account}`; `url` must be `https://claude.ai/…` |
| `migrate` | – | `{ok:true, profiles:[{profile, email, outcome, reason?, label?}], accounts: AccountView[], needSignIn: string[]}` |
| `profiles.env` | `{name}` | `{ok:true, env: {CLAUDE_CONFIG_DIR: string}, unset: ["CLAUDE_CODE_OAUTH_TOKEN"]}` |
| `relogin.start` | `{emails: string[]}` | `{ok:true, order: string[], skipped: [{email, reason}], driver: {profile: string \| null}, log: string}` (native host only, §4.10) |
| `relogin.status` | `{}` | `{ok:true, running: boolean}` (native host only) |
| `relogin.stop` | `{}` | `{ok:true, stopped: boolean}` (native host only) |

Validation rules:

- An unknown `type` returns `unsupported`.
- A bad name or parameter returns `invalid_request`.
- `url`, when present, must parse with `new URL`, use protocol `https:` or `http:`, and must not start with `-`. Anything else is `invalid_request`. This stops a URL from being read as a Chromium flag.
- `configDir`, when present, must be an absolute path to an existing directory.
- `profiles.remove` on a running profile returns `running`.
- `profiles.env` on a profile without `configDir` returns `invalid_request`.
- `AccountView` is `{name, label, email, status: "ok"|"revoked"|"unknown"|null, checkedAt, sessionExpiresAt, state: "signed-in"|"expiring"|"signed-out"|"unknown", active}`. `state` is `signed-out` when revoked or past `sessionExpiresAt`, `expiring` when ok and within 3 days of it. `name` is the label slugged to the profile-name pattern, with `-2`, `-3`… on collisions, so kanban's name check still passes. An account reference matches the label, then `name`, then email, then the label case-insensitively, then an old profile's email.
- Over the native host, only `ping`, `profiles.list`, `profiles.status`, `accounts.report`, `relogin.start`, `relogin.status` and `relogin.stop` are allowed, plus the bridge messages of §4.11. Any other type returns `unsupported`, so add, remove, launch and migrate stay with the CLI and HTTP, and the extension never asks the launcher to call back into it.
- `accounts.report {accounts}` writes `accounts.json` from at most 100 summaries, keeping only the `AccountView` fields, and only when `current === null`; from an old profile it is ignored.
- The `relogin.*` types exist only over the native host: `handle` (CLI and HTTP) answers them with `unsupported`, and `handleNative` dispatches them. `emails` must be 1–20 strings; they are lowercased and deduplicated, and any that are not plain addresses come back in `skipped` with reason "unsupported email address". They run from the main Chromium (`current === null`, Claude in Chrome identity read from the default user-data-dir) or from an old profile.

### 4.5 Old-profile launch (`chromium.ts`, `claudeExt.ts`, `running.ts`), used only by `migrate`

1. **Running detection** (`running.ts`):
   - `parseSingletonLock(target: string): {host: string; pid: number} | null` splits the `readlink` target on its last `-`. For example, `pilot-2353` gives `{host:"pilot", pid:2353}`.
   - `isRunning(userDataDir, hostname = os.hostname(), alive = pidAlive): {running: boolean; pid: number | null}`. It returns running only when the lock exists, the lock host equals `hostname` or `hostname.split(".")[0]`, and `alive(pid)`. `pidAlive` is `process.kill(pid, 0)`, with `EPERM` counting as alive.
   - The research showed the lock survives SIGTERM, so a stale lock means not running.
2. **Find Claude in Chrome** (`claudeExt.ts`):
   - `findClaudeExtension(sourceDir): {version: string; dir: string} | null` lists the subdirectories that hold a `manifest.json`. Directory names look like `1.0.102_0`.
   - It picks the highest by comparing the numeric dot-segments, then the `_N` suffix.
   - `version` is the manifest's `version`.
3. **Vendor the copy:** `vendorClaudeExtension(home, sourceDir)` copies that folder with `fs.cpSync(..., {recursive: true})` to `vendor/claude-in-chrome/<versionDir>/`, if it is not already there, and returns the vendored dir.
   - Copy it verbatim, including `_metadata`; that copy was tested and keeps the id.
   - The source is never modified.
   - If no source is found, the launch carries on without it and `claudeInChromeVersion` is `null`.
4. **Write host manifests** into `profiles/<name>/NativeMessagingHosts/` (see 4.6). Do this on every launch, idempotently.
5. **Args** (`buildLaunchArgs`, pure):

   ```ts
   buildLaunchArgs({ userDataDir, extensionDirs, url, extraArgs }): string[]
   // => [`--user-data-dir=${userDataDir}`, "--profile-directory=Default", "--no-first-run",
   //     "--no-default-browser-check", `--load-extension=${extensionDirs.join(",")}`,
   //     ...extraArgs, ...(url ? [url] : [])]
   ```

   `extensionDirs` is the vendored Claude in Chrome directory (when found), followed by our extension directory.
6. **Spawn:** `spawn(CCP_CHROMIUM, args, {detached: true, stdio: "ignore"}).unref()`.
   - If the binary is missing, return `chromium_not_found`.
   - If the profile was already running, still spawn: Chromium passes the arguments to the running instance, which opens a window or the URL and exits. Return `alreadyRunning: true`.
   - We do not use `open -na`. Direct spawn of the binary was tested and starts an independent instance next to the user's main Chromium.
7. **After spawn:** poll `isRunning` every 100 ms for up to 10 s, then return the view. If the profile still is not running, return `internal` with the message "Chromium did not start".

### 4.6 Native host

**`hostManifest.ts`**

```ts
export const HOST_NAME = "engineer.cute.claude_profiles";
export const EXTENSION_ID = "bkgjdpakjigjgdggfcckikppbjjcdkim";
export const buildHostManifest = (wrapperPath: string) => ({
  name: HOST_NAME, description: "Claude Profiles launcher", path: wrapperPath, type: "stdio",
  allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
});
export const installHostInto = (home: string, nmhDir: string): void  // writes our manifest + copies Claude Code's
```

**Wrapper `CCP_HOME/bin/native-host`**

Write it on `install-host`, `add` and `launch`. Use absolute paths: Chromium starts hosts with a minimal `PATH`, and `node` is not on `PATH`.

```sh
#!/bin/sh
exec "<process.execPath>" --disable-warning=ExperimentalWarning "<abs repo>/launcher/src/cli.ts" native-host "$@"
```

**Claude Code host manifest copy**

- If `~/Library/Application Support/Chromium/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json` exists, copy it byte for byte into each profile's `NativeMessagingHosts`.
- The bridge does not need this file. It only keeps Claude in Chrome's native and status path from failing with "host not found".
- Never edit or rewrite the original.

**`install-host [--chromium-default]`**

- Installs into every managed profile.
- With `--chromium-default`, it also writes our manifest, and only our manifest, to `~/Library/Application Support/Chromium/NativeMessagingHosts/`. That is for loading the extension into the main profile by hand.
- This flag is the only operation that writes outside `CCP_HOME`.

**`nativeHost.ts`**

```ts
export const encodeMessage = (msg: unknown): Buffer          // 4-byte LE length + UTF-8 JSON
export const createDecoder = (onMessage: (msg: unknown) => void): (chunk: Buffer) => void  // handles split/joined chunks
export const runNativeHost = (input: NodeJS.ReadableStream, output: NodeJS.WritableStream,
  handler: (msg: unknown) => Promise<unknown>): Promise<void>  // resolves on stdin end
export const currentProfileFromParent = (home: string, ppid = process.ppid): string | null
```

- **Current profile:** `currentProfileFromParent` runs `ps -o args= -p <ppid>` and extracts `--user-data-dir=(.+?)(?= --|$)`. It returns the profile whose `userDataDir` equals that path after `realpath`, or `null`.
  - This works because the wrapper uses `exec`, which leaves Chromium's browser process as the parent. `current` in `profiles.list` comes from this lookup.
- **Size and logging:** a response over 1,000,000 bytes is replaced by `internal` "response too large", because host-to-browser messages are capped at 1 MiB (measured). Logs go to stderr only.
- **Caller origin:** `argv[1]` is the caller's origin. If it is not `chrome-extension://bkgjdpakjigjgdggfcckikppbjjcdkim/`, reply `unauthorized` to every message.

### 4.7 HTTP API (`server.ts`, `token.ts`)

**Startup**

- `serve [--port N]` binds to `127.0.0.1` only, never `0.0.0.0` or `::`.
- `ensureToken(home)` creates the `token` file with 32 random bytes in hex, mode 0600, and returns it.
- `serve` prints one line to stderr: `ccp serving on http://127.0.0.1:<port> (token in <path>)`. It never prints the token.

**Request rules**

- **Host header:** must be `127.0.0.1:<port>` or `localhost:<port>`. Anything else gets 403 `unauthorized`, which defends against DNS rebinding.
- **Auth:** every route except `/v1/health` needs `Authorization: Bearer <token>`, compared with `crypto.timingSafeEqual` after a length check. Failure is 401 `unauthorized`.
- **Bodies:** `content-type: application/json` is required when there is a body, with a 16 KiB limit. Violations are 400 `invalid_request`.
- **Responses:** no CORS headers. Every response is JSON with `cache-control: no-store`.

**Routing:** `matchRoute(method: string, pathname: string)` is pure and exported, returning a route object or `{kind: "not-found"}` / `{kind: "method-not-allowed"}`.

| Method & path | Maps to | Status |
|---|---|---|
| `GET /v1/health` | `ping` | 200 (no token) |
| `GET /v1/profiles` | `profiles.list` (`current: null`) | 200 |
| `POST /v1/profiles` `{name,email?,configDir?}` | `profiles.add` | 201 |
| `GET /v1/profiles/:name` | `profiles.status` | 200 |
| `DELETE /v1/profiles/:name` | `profiles.remove` (`?keepData=1`) | 200 |
| `POST /v1/profiles/:name/launch` `{url?}` | `profiles.launch` (= `accounts.open`) | 200 |
| `GET /v1/accounts` | `accounts.list` | 200 |
| `GET /v1/accounts/:name` | `accounts.status` | 200 |
| `POST /v1/accounts/:name/open` `{url?}` | `accounts.open` | 200 |
| `POST /v1/open-for` `{url}` | `accounts.openFor` | 200 |
| `GET /v1/profiles/:name/env` | `profiles.env` | 200 |

**Error statuses:** the error body is the `Failure` shape.

| Status | When |
|---|---|
| 400 | `invalid_request` |
| 401 / 403 | `unauthorized` |
| 404 | `not_found`, unknown route |
| 405 | wrong method |
| 409 | `already_exists`, `running` |
| 409 | `session_expired` |
| 422 | `chromium_not_found`, `unsupported` |
| 503 | `browser_unavailable` |
| 500 | `internal` |

### 4.8 CLI (`cli.ts`)

```
ccp list [--json]
ccp add <name> [--email E] [--config-dir D] [--json]
ccp remove <name> [--keep-data] [--json]
ccp launch <name> [--url U] [--json]
ccp status [<name>] [--json]
ccp env <name>                # prints: unset CLAUDE_CODE_OAUTH_TOKEN; export CLAUDE_CONFIG_DIR='<dir>'
ccp import-cswap [--json]
ccp serve [--port N]
ccp install-host [--chromium-default]
ccp native-host <origin>      # invoked by Chromium only
```

**`--json` output and exit codes**

- `--json` prints exactly the `Result` from §4.4, plus `"schemaVersion":1` at the top level of `list`. kanban parses this.
- Without `--json`, output is a human table: name, running dot, email, pid.
- Exit codes:

  | Code | Meaning |
  |---|---|
  | 0 | ok |
  | 1 | `Failure` |
  | 2 | usage error |

- `status` with no name behaves like `list`.

**`import-cswap`** (`cswap.ts`)

- Runs `$CSWAP_BIN list --json` with a 30 s timeout and requires `schemaVersion: 1`.
- For each account `{number, email}` with no existing profile of that email, it adds a profile:
  - name `acct-<number>`;
  - email;
  - `configDir` = `~/.claude-swap-backup/sessions/<number>-<email>` when that directory exists, otherwise `null`. Use the same sanitising as kanban's `profileDir`: read `src/server/accounts.ts` and copy the rule, because a mismatch breaks pairing silently.
- Returns `{ok:true, added: ProfileView[], skipped: number}`.

**Pairing Claude Code with a profile** (README text): run `eval "$(ccp env <name>)" && claude --chrome`, launch the profile once, and sign Claude in Chrome into the same account.

### 4.9 Launcher acceptance

- Every exported function named in §4.5–4.7 exists with the stated signature.
- On a clean `CCP_HOME`, running `ccp add a --email a@example.com --json` and then `ccp list --json` gives `schemaVersion: 1` and one profile with `running: false`. Adding `b --email A@example.com` fails with `already_exists`, exit code 1.
- `ccp launch a` opens a GUI window in which both extensions appear in `chrome://extensions`, with Claude in Chrome at id `fcoeo…` and Claude Profiles at id `bkgjd…`.
- `ccp serve`:
  - `curl` to `/v1/health` returns 200;
  - `/v1/profiles` without the token returns 401, and with it returns 200;
  - the `lsof` listing shows `127.0.0.1:47321` only.
- A case-insensitive grep for the employer name across the repo finds nothing.

### 4.11 Bridge (`bridge.ts`, `nativeHost.ts`)

- The extension's port sends `{type:"bridge.attach"}` first; the host answers `{ok:true, attached:true, browser}` and serves its socket. A second attach on the same port is a no-op.
- Each socket request `{type, ...params, timeoutMs?}` is checked against the socket's allowlist, then forwarded as `{type:"bridge.request", id, request}`; the extension answers `{type:"bridge.reply", id, response}`, which the host writes back. Requests time out after `timeoutMs` (default 30 s, at most 10 min).
- `main.sock` allows `ping`, `accounts.list`, `accounts.check`, `accounts.open {label, url}`, `accounts.openFor {url}` and `accounts.import {label, email, cookies}`. `profile-<name>.sock` allows `ping` and `accounts.exportLive`. Anything else is `unsupported` without reaching the browser.
- The extension may also send `accounts.report` on the port, handled as in §4.4.
- When the port closes the host fails pending requests with `browser_unavailable`, removes its socket and exits. A client that cannot connect gets `browser_unavailable`.
- Requests over 256 KiB are refused. Responses may carry cookies only for `accounts.exportLive`; the launcher never prints them.

### 4.12 Migrate (`accounts.ts`)

- Needs the main bridge. For each old profile, in `profiles.json` order: if it is not running, start it with `--headless=new` added; wait up to 30 s for `profile-<name>.sock` to answer `ping`; call `accounts.exportLive`; pass `{label: profile.email ?? email, email, cookies}` to the main browser's `accounts.import`; stop the browser if it started it.
- Outcomes: `imported`; `already-signed-in` (the main Chromium's jar for that email still works, so it is kept); `signed-out` (`session_expired` from either side); `unreachable` (did not start, extension did not connect, or claude.ai could not be reached), each with a `reason`.
- It never deletes an old profile or its data, never logs out, and never prints cookies.

### 4.10 Sign back in (`claudeInChrome.ts`, `relogin.ts`)

A saved claude.ai account whose session was revoked can only be restored by signing in again. Claude in Chrome cannot be driven by another extension, so the launcher starts Claude Code (`claude -p --chrome`) against this browser's Claude in Chrome and has it follow each account's emailed magic link.

**Driver identity** (`claudeInChrome.ts`)

- `readClaudeInChromeIdentity(userDataDir): {accountUuid, bridgeDeviceId} | null` reads the raw bytes of every `*.ldb` and then every `*.log` (best effort; compressed data simply doesn't match) in `<udd>/Default/Local Extension Settings/fcoeoabgfenejglbffodgkkbkcdhcgfn/` as latin1, each kind in file-name order, so the live log wins over tables that LevelDB may number higher, and takes the last UUID-shaped JSON string after each key (`parseIdentity`). Neither value is logged or returned to the extension.
- `findDriverConfigDir(accountUuid, configDirs)` returns the first dir whose `<dir>/.claude.json` has `oauthAccount.accountUuid` equal to it. Candidates are every profile's `configDir`, then every subdirectory of each `CCP_DRIVER_DIRS` entry, then each of `relogin.json`'s `driverDirs`.
- The browser is the main Chromium (identity from its default user-data-dir) when `current` is null, else the old profile.

**Mailboxes** (`CCP_HOME/relogin.json`)

```json
{"mailboxes":[{"match":"@example.com","url":"https://mail.example.com/?u={email}#search","priority":10},{"match":"me@example.org","url":"https://mail.example.org/"}]}
```

- `match` starting with `@` matches the email's domain or any subdomain of it, case-insensitively; anything else is an exact email. The first matching entry wins.
- `url` must be https with a hostname of only `[a-z0-9.-]`; `{email}` becomes `encodeURIComponent(email)`. `priority` (default 0) orders accounts, higher first; ties keep request order.
- Optional `driverDirs` (absolute paths, each a Claude Code config dir) and `claude` (absolute path, used when `CCP_CLAUDE` is unset), because the main Chromium starts the launcher with its own environment.
- A missing file means no mailboxes. An invalid file returns `invalid_request` naming the problem. Accounts with no mailbox are returned in `skipped` with reason "no mailbox in relogin.json"; if none remain, `invalid_request`.

**The run**

- Binary: `CCP_CLAUDE`, else `relogin.json`'s `claude` [`/opt/homebrew/bin/claude`]; not executable → `invalid_request`.
- argv: `-p <prompt> --chrome --restricted --strict-mcp-config --tools ToolSearch --permission-mode dontAsk --no-session-persistence --max-budget-usd 5 --output-format json --allowedTools=<the claude-in-chrome tools>,ClaudeInChromeDomain(claude.ai),ClaudeInChromeDomain(<each mailbox host>)`. The tools are `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `navigate`, `read_page`, `find`, `get_page_text`, `computer`, `form_input`, `select_browser` and `list_connected_browsers`; never `javascript_tool`, since the agent reads untrusted mail. `dontAsk` overrides a config dir's `bypassPermissions` default, and `--restricted` ignores that dir's user settings (permissions and hooks).
- env is an allowlist, nothing else from the launcher's environment: `HOME`, `USER`, `LOGNAME`, `PATH=<dirname(claude)>:/usr/bin:/bin:/usr/sbin:/sbin`, `CLAUDE_CONFIG_DIR=<driver dir>`, `CLAUDE_CHROME_PAIRED_DEVICE_ID=<bridgeDeviceId>`. Never `CLAUDE_CODE_OAUTH_TOKEN`.
- The prompt selects the browser by device id first, works only in its own new tab group, and per account: opens `/login`, asks for an email link, finds the newest sign-in email from Anthropic from the last 15 minutes in the mailbox (reloading every 20 seconds for up to 4 minutes), requires the link to start with `https://claude.ai/magic-link#` and its base64 part to decode to that email, and opens it in the same tab. It stops on any CAPTCHA, Cloudflare challenge or 6-digit-code prompt, never logs out, never sends or changes mail, and closes its tabs at the end.
- `relogin.start` returns `invalid_request` "Already signing back in" while the profile's previous driver is still running.
- Spawned detached with stdout and stderr appended to `logs/relogin-<iso>.log`, then unref'd; its pid goes to `logs/relogin-<profile>.pid` and `relogin.start` returns as soon as it has spawned. `relogin.status` reports whether that process group is alive (removing a dead pid file), and `relogin.stop` sends it SIGTERM and removes the file. The extension (§5.3) notices each new `sessionKey`, saves it into the matching jar, and clears cookies before the next account.

## 5. extension/

### 5.1 `manifest.json` (exact)

```json
{
  "manifest_version": 3,
  "name": "Claude Profiles",
  "version": "0.3.0",
  "description": "Keep every Claude account in one Chromium and let agents switch and open claude.ai sessions.",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApsOB8/9r26rcuLGR+VHgUV6ZnwJueFmlMycFrCJkxny7BwsnxFty2Niy/hvaPzESDb/o+8KjsbxOlQlblje8HZnm6eTm60PDGqJ0xHjRjNF5L/M8OG5dh7rWz/MAp3BUpq5Nfa6YL4ukOxieWPOeVksWRHUiNa8P7eMQAC0sGyIBEq2GMVM4GCL2bpCOUoUN6NsCV10Ax8wvM7KFJX2NNuXBqUx2Fd0EqyyTrTFbRjsB4RRJcWayumYTuWxqfaNNqVi0s8YC/nPZphux2mIOUU22exiPrye/m/vzNGgA4RwId2/Qr1n7vzkVIKNzscn5jS+V9WHBmjtZCKUefwmb/QIDAQAB",
  "permissions": ["nativeMessaging", "cookies", "storage", "offscreen", "declarativeNetRequestWithHostAccess", "alarms", "scripting"],
  "host_permissions": ["https://claude.ai/*", "https://*.claude.ai/*"],
  "background": { "service_worker": "service-worker.js", "type": "module" },
  "action": { "default_popup": "popup.html", "default_title": "Claude Profiles" },
  "externally_connectable": {
    "matches": ["https://claude.ai/*", "https://*.claude.ai/*"]
  }
}
```

The extension uses plain ES modules with no build step and no icons; Chromium's default icon is fine.

### 5.2 Messages

**Envelope:** the same as §4.4. Responses are always the `Result` shape. Popup→worker messages go through `chrome.runtime.sendMessage` and external callers through `onMessageExternal`; both reach one dispatcher, `dispatch(msg, {external: boolean})`.

| type | handled by | popup | external |
|---|---|---|---|
| `ping` | native host (`lib/native.js` → `chrome.runtime.sendNativeMessage(HOST_NAME, msg)`) | yes | yes |
| `profiles.list` | native host | yes | yes |
| `accounts.open` `{label, url?}` | jars → switch if not active, open `url` (or focus a claude.ai tab) → `{ok:true, label, email, switched, reloadedTabs, tabId}` (external: no `email`) | yes | yes |
| `bridge.status` | `{ok:true, connected}` | yes | no |
| `accounts.list` | `lib/jars.js` → `{ok:true, accounts:[{label, savedAt, cookieCount, email, status, checkedAt}]}` (external: no `email`) | yes | yes |
| `accounts.check` | jars → probes every jar, same body as `accounts.list` | yes | no |
| `accounts.relogin` | jars → native `relogin.start` → `{ok:true, started, order?, skipped?, driver?, message?}` | yes | no |
| `accounts.reloginCancel` | jars → same body as `accounts.list`, with `relogin: null` | yes | no |
| `accounts.save` `{label?}` | jars → `{ok:true, account:{label,savedAt,cookieCount,email,status,checkedAt}}`; saved into the jar that already has the live email, else under `label`, else the email made label-safe | yes | **no** |
| `accounts.signIn` | jars → saves the live account as `accounts.save` does (when signed in), clears claude.ai cookies, opens claude.ai/login → `{ok:true, saved: summary \| null}`; `unknown` live check → error, nothing cleared | yes | **no** |
| `accounts.switch` `{label}` | jars → `{ok:true, reloadedTabs:number}` | yes | yes |
| `accounts.forget` `{label}` | jars → `{ok:true}` | yes | **no** |

- A disallowed external type gets `unsupported`.
- If `chrome.runtime.lastError` is set during native messaging, the reply is `{ok:false, error:{code:"native_host_unavailable", message:"Run: ccp install-host"}}`.
- Labels match `^[A-Za-z0-9 ._@+-]{1,64}$`. An email becomes a label with any other character replaced by `_`, cut to 64.

### 5.3 Cookie jars (`lib/jars.js`)

**Storage**

- Saved jars live in `chrome.storage.local` under the key `jars`, shaped as `{[label]: {savedAt, cookies: SavedCookie[], email?, check?}}`.
- Cookie values exist only in that storage and in `chrome.cookies` calls. Never put them in `console.*`, in a response, or in the DOM.

**Exports** (pure, unit-tested in `extension/test/jars.test.js`)

- `isInfraCookie(name)`: true for `__cf_bm`, `cf_clearance`, `_cfuvid` and `__cflb`. These are left alone because they are tied to the browser and IP.
- `toSavedCookie(c)`: keeps `name`, `value`, `domain`, `path`, `secure`, `httpOnly`, `sameSite`, `expirationDate?` and `hostOnly`.
- `toSetDetails(saved)`:
  - `url` is `https://${domain without leading dot}${path}`;
  - `domain` is omitted when `hostOnly`;
  - `expirationDate` is omitted for session cookies;
  - `name`, `value`, `path`, `secure`, `httpOnly` and `sameSite` are carried over.
- `toAccountSummary(label, jar)`: `{label, savedAt, cookieCount, email, status, checkedAt}`, with `null` for a missing email or check.
- `classifyAccountResponse({status, cfMitigated, email})`: the session check rule below.
- `cookieHeader(cookies)`: `name=value; name=value`.
- `probeRule(id, extensionId, header)`: the declarativeNetRequest session rule below.

**Operations**

- **save:** `chrome.cookies.getAll({domain: "claude.ai"})`, filter out infra cookies, store. If no `sessionKey` cookie is present, fail with `invalid_request` and the message "Not signed in to claude.ai".
- **switch:**
  1. Remove every non-infra cookie returned by `getAll({domain: "claude.ai"})`.
  2. Set each saved cookie.
  3. Reload every tab from `chrome.tabs.query({url: ["https://claude.ai/*", "https://*.claude.ai/*"]})`; host permissions are enough for this.
  4. Return the count of reloaded tabs.
  - Before step 1 the outgoing session is checked live; after step 2 the new one is. If the new one is not ok, the previous cookies go back: a revoked session returns `session_expired` (and records the jar as revoked), anything else returns `internal`.
- **Default store only:** incognito is out of scope.

**Session checks**

- A jar may carry `email` (recorded on save and on every ok check) and `check: {status: "ok" | "revoked" | "unknown", checkedAt}`.
- A jar is checked without touching the cookie store: a declarativeNetRequest session rule sets the `cookie` header (the jar's cookies plus the live Cloudflare cookies) on `https://claude.ai/api/account?ccp_probe=<id>` for requests initiated by this extension, the worker fetches it with `credentials: "omit"`, and the rule is removed in `finally`.
- Classification: 200 with `email_address` → `ok`; 401, or 403 without a `cf-mitigated` header → `revoked`; anything else → `unknown`.
- The popup checks on open; an alarm checks hourly. The action badge shows the number of revoked jars in red.
- Switching away from an ok session first writes its current cookies back into the jar with the same email, so refreshed session keys are not lost.

**Sign back in**

- `accounts.relogin` checks every jar, takes the revoked ones with a known email, refreshes the jar for the live session, and calls native `relogin.start` (§4.10). On success it stores `relogin: {pending, accounts, restoreLabel, startedAt, log}` in `chrome.storage.local` and clears the claude.ai account cookies.
- It refuses with `invalid_request` "Already signing back in" while a relogin is active, and with `invalid_request` "Save the current claude.ai account first…" when the live session is ok but matches no jar. A live check that can't reach claude.ai returns `internal`.
- While a relogin is active a `relogin-expire` alarm fires every minute; it ends the relogin once native `relogin.status` reports the driver is no longer running (the agent skipped or stopped an account).
- While a relogin is active, each new `sessionKey` cookie waits 10 seconds, so claude.ai's magic-link page finishes setting its cookies, then runs a live check, retrying up to 3 times 10 seconds apart while it can't reach claude.ai. An ok session whose email is pending is saved into that jar (or a new jar labelled with the email) and removed from `pending`, and cookies are cleared for the next account (or it finishes).
- It finishes when `pending` is empty, when the driver has exited, on cancel, or after the larger of 20 minutes and 6 minutes per account in `accounts` since `startedAt`; cancel and expiry first call native `relogin.stop`. Then the alarm is cleared, the `restoreLabel` jar is restored, claude.ai tabs reload, the state is deleted and the jars are checked again.

**One browser, every account (v0.3)**

- `sessionExpiresAt(cookies)`: the saved `sessionKey`'s `expirationDate` as ISO, or null. `toAccountSummary` includes it; a jar past it counts as signed out for the badge.
- Every `writeJars` sends `accounts.report` with `toReport` summaries (label, email, status, checkedAt, sessionExpiresAt) over the bridge port when connected.
- Bridge handlers (`service-worker.js` `handleBridge`): `ping`; `accounts.list` and `accounts.check` → summaries plus `active` (the label whose email matches the live session); `accounts.open`; `accounts.openFor`; `accounts.import`; `accounts.exportLive`. Each runs in the jars' serial queue.
- `accounts.openFor {url}`: `url` must be https on claude.ai. Order: the active account, then every other jar not known revoked, by label. For each it switches (except for the active one, first), loads `url` in one tab of its own, and reads the page text with `chrome.scripting.executeScript` until `classifyPage` decides: `signed-out` on `/login` or `/magic-link`, `not-found` on "couldn't be found" and similar, `found` once 8 s have passed since load with neither (at most 25 s). On `found` it focuses the tab and returns; if none, it closes its tab, switches back to the starting account and returns `not_found` naming each result.
- `accounts.exportLive`: the live claude.ai account cookies (no Cloudflare cookies) and email, only while the live check is ok; `session_expired` when revoked.
- `accounts.import {label, cookies}`: at most 200 cookies on claude.ai, Cloudflare ones dropped, a `sessionKey` required. The jar is probed (§5.3 session checks) without touching the live cookies; revoked → `session_expired`. If a jar for that email already passes a probe it is kept (`imported:false`); otherwise the session is saved into that jar, or a new one labelled with the given label (or the email made label-safe).

### 5.4 Popup

`popup.html`, `popup.js` and `popup.css`, at a 320 px width.

- **Agents section** (v0.3, replaces the Profiles section): one line saying whether `ccp` can reach this browser (`bridge.status`), the launcher's ping time, and an error from the native host inline (e.g. "Run: ccp install-host").
- **claude.ai tab account section:**
  - "Save current", which saves the signed-in account under its email (no label to type), and "Sign in another account", which saves the signed-in account the same way, clears the claude.ai cookies and opens claude.ai/login;
  - a list of saved jars, each with "Switch" and "Forget" buttons;
  - fixed helper text: "One Chromium for every account: switching changes the claude.ai login in all of this browser's claude.ai tabs. Claude in Chrome keeps its own login."
  - each jar shows a status chip: "Signed in", "Expires soon" (amber, within 3 days of `sessionExpiresAt`), "Signed out" (red, revoked or expired), or "Unchecked" / "Couldn't check" (muted), titled with the check and expiry times; the cached list renders first, then `accounts.check` re-renders it;
  - "Sign back in to signed-out accounts" appears when at least one jar is signed out and no relogin is active. While one is active the popup shows "Signing back in: <emails> — Claude is driving this browser" with "Cancel"; after starting it lists skipped emails with reasons and the driver.

### 5.5 Extension acceptance

- Loading the folder with `--load-extension` shows id `bkgjdpakjigjgdggfcckikppbjjcdkim`. The e2e test asserts this.
- `node --test 'extension/test/*.test.js'` passes: the infra filter, hostOnly domain omission, session-cookie expiration omission, and the URL built for `.claude.ai` versus `claude.ai`.
- No occurrence of `console.log(` that could contain cookie objects. `grep -n "value" extension/*.js extension/lib/*.js` shows value used only inside `toSavedCookie` and `toSetDetails`.

## 6. kanban integration (`~/workspace/kanban`)

**kanban is a PUBLIC repository** (`kranners/kanban`, AGPL).

- Fixtures, the demo and tests use only fictional data: `example.com` emails, `/Users/me` paths, profile names like `acme-one`.
- No real email or `~/.claude-swap-backup/sessions/...` path may appear anywhere.
- No employer names may appear in code, commits or branches.
- Follow its `CLAUDE.md` and `CONTRIBUTING.md`: work on branch `chrome-profiles`, run `npm run check`, use Conventional Commits, rebase on `origin/main`, merge to `main`, push, then `git pull --ff-only && npm run build` in the main checkout.
- The work uses tabs, double quotes, arrow-const exports, `.ts` import extensions and no comments.

**Transport:** the CLI, not HTTP. This is the existing cswap/cmux pattern, and kanban holds no port or token.

### 6.1 Files

1. **`src/server/config.ts`:** add `ccpBin: env.CCP_BIN || "ccp"`.
   - Operators set `CCP_BIN` to the absolute path of `launcher/bin/ccp`.
   - The kanban server must run in the user's GUI login session, or the Chromium windows it spawns will not appear.
2. **`src/server/chromeProfiles.ts`** (new, with `chromeProfiles.test.ts`), modelled on `accounts.ts`:
   - `parseChromeProfiles(json: unknown): ChromeProfile[] | null` requires `schemaVersion === 1` and an array `profiles`. From each profile it keeps only `name`, `email` and `running`, and drops paths, `pid` and `configDir`.
   - `ccpList(bin): Promise<{ok:true; value: ChromeProfile[]} | {ok:false; error:string}>` runs `execFile(bin, ["list","--json"])` with a 10 s timeout.
   - `ccpLaunch(bin, name): Promise<AccountResult>` validates `name` against `^[a-z0-9][a-z0-9-]{0,31}$` first, then runs `execFile(bin, ["launch", name, "--json"])` with a 30 s timeout. It maps `{ok:true}` to `{ok:true}`, maps a failure to `{ok:false, error: error.message}`, and turns a spawn failure into "ccp is not installed or CCP_BIN is wrong".
3. **`src/shared/types.ts`:** add `export type ChromeProfile = { name: string; email: string | null; running: boolean };`. Launch reuses `AccountResult`.
4. **`src/server/http.ts`:**
   - Add `chromeProfiles(): Promise<{ok:true; value: ChromeProfile[]} | {ok:false; error:string}>` and `launchChromeProfile(name: string): Promise<AccountResult>` to `ServerDeps`.
   - Add the routes:
     - `GET /api/chrome-profiles` returns 200 `{profiles: ChromeProfile[], error?: string}` (`{profiles: [], error}` on failure). Other methods get 405.
     - `POST /api/chrome-profiles/launch` with body `{name}` goes through `readBody` (origin plus JSON checks). A missing or invalid name returns 400. It calls the dependency and then `deps.audit({action: "chrome-profile-launch", name, identity, result})`, and responds `sendJson(res, result.ok ? 200 : 422, result)`. GET gets 405.
   - If the audit event union is typed, extend it.
5. **`src/server/main.ts`:** wire `chromeProfiles: () => ccpList(config.ccpBin)` and `launchChromeProfile: (name) => ccpLaunch(config.ccpBin, name)`.
6. **`src/server/http.test.ts`:**
   - `matchRoute` assertions for both paths;
   - fakes in the full `ServerDeps`;
   - launch tests covering 200, 422, 400 (bad name), 405 (GET), 403 (bad origin), and the audit entry.
7. **`src/web/usage.ts`:** add `fetchChromeProfiles(): Promise<{profiles: ChromeProfile[]; error?: string}>` and `launchChromeProfile(name): Promise<AccountResult>`, mirroring `makeDefault`'s error handling.
8. **`src/web/Usage.tsx`:**
   - `AccountList` fetches the profiles once on mount and again after each launch.
   - Each `AccountRow` whose `email` matches a profile email (case-insensitive) gets a running dot and a `<button type="button" class="usage-open-browser">`. Its label is `pending ? "Opening…" : running ? "Focus browser" : "Open browser"`.
   - A failure shows the same way as for make-default.
   - Add any styles to the existing usage CSS.
   - No new rail view.
9. **`src/demo/backend.ts` and `backend.test.ts`:**
   - Add handlers: `GET /api/chrome-profiles` returns `{profiles: [{name: "acme-one", email: "one@example.com", running: false}]}`, and `POST /api/chrome-profiles/launch` returns `{ok: false, error: "The demo can't open browsers"}`.
   - Add probes for both, or the coverage test fails.

### 6.2 kanban acceptance

- `npm run check` passes.
- With `CCP_BIN` pointing at a fake script that prints a fixture, the Usage panel shows "Open browser" on the matching row.
- `git log -p origin/main..HEAD | grep -i -E "claude-swap-backup/sessions/[0-9]"` returns nothing, and neither does a case-insensitive grep of it for the employer name.

## 7. Tests (TESTS builder)

### 7.1 Unit tests in `launcher/test/*.test.ts`

Use `node:test` and `node:assert/strict`. Each test gets a temp `CCP_HOME` from `fs.mkdtempSync(os.tmpdir() + "/ccp-")`. Tests never touch `~/.config` or the real Chromium.

- **store:**
  - add, list and remove round-trip;
  - invalid names (`A`, `-a`, 33 characters, `a/b`) are rejected;
  - a duplicate email in different case is rejected;
  - the `profiles.json` mode is 0600;
  - remove deletes the data directory unless `keepData`.
- **running:**
  - `parseSingletonLock("pilot-2353")`;
  - a host containing a dash, `my-mac-123` → host `my-mac`, pid 123;
  - garbage input gives null;
  - `isRunning` against a real symlink in a temp dir, with an injected `alive`: true/false, plus a host mismatch;
  - a missing lock gives not running.
- **chromium:** the exact `buildLaunchArgs` output, with and without `url` and `extraArgs`. Also, `profiles.launch` with `url: "--foo"` and `url: "file:///etc/passwd"` gives `invalid_request`, and never starts an old profile.
- **bridge:** a round trip over a socket with mode 0600 in a 0700 directory, allowlist refusal before the browser, timeout, `browser_unavailable` once closed, `bridge.attach` choosing `main.sock` or `profile-<name>.sock`, account state and expiry, names and resolution, `accounts.json` keeping only summary fields, `list` falling back to it, `launch` and `open-for` requests, and `migrate` outcomes with no cookie value in its result.
- **claudeExt:**
  - a fake source with `1.0.9_0`, `1.0.102_0` and `1.0.102_1` picks `1.0.102_1`;
  - a directory without a manifest is ignored;
  - a missing source gives null;
  - vendoring copies once and does not overwrite on the second call.
- **nativeHost:**
  - `encodeMessage` produces the LE length prefix;
  - the decoder handles one message split across 3 chunks and two messages in one chunk;
  - `runNativeHost` over `PassThrough` streams answers `ping`;
  - a wrong origin gives `unauthorized`.
- **hostManifest:**
  - `allowed_origins` is exact;
  - `sha256(base64decode(extension/manifest.json key))` maps to `bkgjdpakjigjgdggfcckikppbjjcdkim`;
  - `installHostInto` copies the Claude Code manifest only if the source exists. Use a fake source via a parameter or env; never read or write the real one.
- **server:** start on port 0 and check:
  - health without a token is 200;
  - `/v1/profiles` without a token is 401, with a wrong token 401, with the right token 200;
  - a bad `Host` header is 403;
  - POST without JSON is 400;
  - a duplicate add is 409;
  - an unknown route is 404;
  - the address is `127.0.0.1`.
- **protocol:** an unknown type gives `unsupported`, and the native-host allowlist rejects `profiles.add`.

### 7.2 e2e smoke: `tests/e2e/smoke.ts`

Run it with node directly; it exits non-zero on failure. It uses a temp `CCP_HOME`, a temp `HOME`, `CCP_NODE` set to the running node, and `CCP_EXTRA_ARGS="--headless=new --remote-debugging-port=0 --use-mock-keychain $CCP_E2E_EXTRA_ARGS"`, and never touches the user's Chromium profile. Off a Mac, set `CCP_CHROMIUM` and `CCP_E2E_EXTRA_ARGS=--no-sandbox`.

1. `bin/ccp add smoke --email smoke@example.com --json` gives `ok` (an old profile).
2. `bin/ccp install-host --chromium-default`, then start `CCP_CHROMIUM` itself on the temp home's default user-data-dir with `--load-extension=extension/`, standing in for the main Chromium.
3. Poll for its `DevToolsActivePort`, find our service worker target, and evaluate `chrome.runtime.sendNativeMessage(HOST_NAME, {type: "profiles.list"})` in it: `ok` with `current === null`.
4. `ccp list --json` reaches the browser (`browser.connected`), with no accounts, no profiles and `legacyProfiles: ["smoke"]`.
5. `ccp launch nobody` and `ccp launch smoke` give `not_found`, and the old profile is never started.
6. `ccp open-for https://example.com/` gives `invalid_request`.
7. `ccp migrate --json` lists `smoke` as `signed-out` or `unreachable` with a reason, and the headless profile it started has stopped.
8. The dispatcher's `accounts.list` is `{ok: true, accounts: []}`. Do not log in and do not set real cookies.
9. SIGTERM the browser; `ccp list --json` then reports `browser.connected: false`.
10. In a `finally` block, kill anything still alive and remove the temp dir.

## 8. Security constraints (all components)

- **Bridge sockets:** unix sockets only, 0600 in a 0700 directory, per-socket allowlists, no TCP and no debugging port. Cookies cross them only for `accounts.exportLive` → `accounts.import` during `migrate`.
- **Network exposure:** the HTTP server binds `127.0.0.1` only, requires a bearer token (0600 file, timing-safe compare), checks the `Host` header, and sends no CORS headers.
- **Native host callers:** only our extension's origin is listed in `allowed_origins`. The host also checks `argv[1]`, and it does not allow add or remove. `relogin.start`, `relogin.status` and `relogin.stop` are native-only and are never exposed to external pages: the extension calls it only from its own popup flow.
- **Secrets:** cookie values, the token, OAuth tokens and `.claude.json` contents are never logged or returned. From `.claude.json` the launcher reads exactly one field, `oauthAccount.accountUuid`, to find the driver config dir for sign back in (§4.10), and compares it without logging or returning it. It never reads the credentials in config dirs.
- **Claude in Chrome storage:** the launcher reads only `accountUuid` and `bridgeDeviceId` from a managed profile's Claude in Chrome storage, and passes the device id only to the spawned Claude Code.
- **Read-only sources:** the user's real Chromium profile and its `NativeMessagingHosts` are read only, except for `install-host --chromium-default`, which the user opts into.
- **URL arguments:** URLs passed to Chromium are validated, so none can be read as a flag.
- **Children:** spawned children use `execFile` or `spawn` with argument arrays, never a shell string. The sign-back-in child gets an allowlisted environment and `dontAsk` permissions limited to the Claude in Chrome tools and domains.
- **Employer names:** none, anywhere, in any repository.

## 9. Caveats and chosen mitigations

| Caveat (from research) | Mitigation |
|---|---|
| Native host socket `/tmp/claude-mcp-browser-bridge-$USER/<pid>.sock` is shared per OS user, and each host broadcasts to every client. | Irrelevant today, since Claude Code 2.1.292 pairs through the cloud bridge. Each profile's host gets its own pid socket, so they coexist. If a future Claude Code switches to the socket pool, accounts would cross over. That is out of scope; it is noted in the README as version-specific. |
| Two profiles on one account share a bridge channel, and tool calls stop to ask which browser. | `add` rejects duplicate emails. The README documents `select_browser` and `CLAUDE_CHROME_PAIRED_DEVICE_ID` for anyone who works around this by hand. |
| `CLAUDE_CODE_OAUTH_TOKEN` overrides the config dir's account. | `ccp env` emits `unset CLAUDE_CODE_OAUTH_TOKEN`. |
| Native messaging manifests are per `--user-data-dir`. | Write both manifests into each profile on add and launch. |
| `--load-extension` copies don't auto-update. | `launch` re-vendors when a newer version folder appears in the source. |
| Unpacked Claude in Chrome needs a sign-in in each profile. | This is a one-time manual step per profile, and it is the pairing step. ccp does not automate logins. |
| Cookie swapping doesn't move Claude in Chrome's account. Open tabs keep stale state, and Cloudflare cookies are bound to the browser. | Scope the feature to claude.ai tabs, skip infra cookies, reload claude.ai tabs, and say so in the popup. |
| Logging out of a saved session invalidates it server-side. | Jars are checked on popup open and hourly; revoked ones show "Signed out" and a badge count, and "Sign back in" restores them through emailed magic links (§4.10). |
| Sign back in reads mail with a driver that can also click and type on the mailbox host, so a crafted email could try to steer it into forwarding the sign-in link. | The prompt forbids sending mail and treats mail as data, and the driver only opens the newest sign-in email from Anthropic. Splitting the mailbox phase into a read-only run would not close it, since opening an email still needs clicks. |
| Sign back in needs a Claude Code config dir on the same account as the browser's Claude in Chrome. | It looks at every profile's `configDir` and `CCP_DRIVER_DIRS`, and fails with a message naming both when none matches. |
| Org policy `allow_claude_browser_extension` can disable Claude in Chrome per account. | Nothing to do. Claude Code reports it. |
| A stale `SingletonLock` survives a kill. | Treat a profile as running only when the host matches and `kill -0` succeeds. |
| Host→browser messages are capped at 1 MiB. | The host replaces oversized responses with an `internal` error. |
