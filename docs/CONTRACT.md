# chromium-claude-profiles: build contract

Status: binding for all implementers. Scope cut: §6 (kanban) and `import-cswap`/`cswap.ts`/`CSWAP_BIN` are out of scope for v0.1 — do not build them.

Original status line: If anything here turns out to be wrong when you test it, stop and report it. Do not work around it quietly.

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
  launcher/test/                 (TESTS builder)
    store.test.ts  running.test.ts  chromium.test.ts  claudeExt.test.ts
    nativeHost.test.ts  server.test.ts  protocol.test.ts  hostManifest.test.ts
  tests/e2e/smoke.ts             (TESTS builder)
  extension/                     (EXTENSION builder)
    manifest.json
    service-worker.js
    popup.html  popup.css  popup.js
    lib/protocol.js  lib/native.js  lib/jars.js
    test/jars.test.js
  (kanban changes live in /Users/aaronpierce/workspace/kanban)   (KANBAN builder)
```

Run every test with `/nix/store/a2v4cjj3vsy455nxxgdi3hfq46qic0wq-nodejs-slim-24.21.0/bin/node --test 'launcher/test/*.test.ts' 'extension/test/*.test.js'`. There is no npm, no dependencies and no build step.

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
node=${CCP_NODE:-/nix/store/a2v4cjj3vsy455nxxgdi3hfq46qic0wq-nodejs-slim-24.21.0/bin/node}
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
| `profiles.launch` | `{name, url?}` | `{ok:true, profile: ProfileView, alreadyRunning: boolean, claudeInChromeVersion: string \| null}` |
| `profiles.env` | `{name}` | `{ok:true, env: {CLAUDE_CONFIG_DIR: string}, unset: ["CLAUDE_CODE_OAUTH_TOKEN"]}` |

Validation rules:

- An unknown `type` returns `unsupported`.
- A bad name or parameter returns `invalid_request`.
- `url`, when present, must parse with `new URL`, use protocol `https:` or `http:`, and must not start with `-`. Anything else is `invalid_request`. This stops a URL from being read as a Chromium flag.
- `configDir`, when present, must be an absolute path to an existing directory.
- `profiles.remove` on a running profile returns `running`.
- `profiles.env` on a profile without `configDir` returns `invalid_request`.
- Over the native host, only `ping`, `profiles.list`, `profiles.status` and `profiles.launch` are allowed. Any other type returns `unsupported`, so add and remove stay with the CLI and HTTP.

### 4.5 Launch (`chromium.ts`, `claudeExt.ts`, `running.ts`)

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
| `POST /v1/profiles/:name/launch` `{url?}` | `profiles.launch` | 200 |
| `GET /v1/profiles/:name/env` | `profiles.env` | 200 |

**Error statuses:** the error body is the `Failure` shape.

| Status | When |
|---|---|
| 400 | `invalid_request` |
| 401 / 403 | `unauthorized` |
| 404 | `not_found`, unknown route |
| 405 | wrong method |
| 409 | `already_exists`, `running` |
| 422 | `chromium_not_found`, `unsupported` |
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

## 5. extension/

### 5.1 `manifest.json` (exact)

```json
{
  "manifest_version": 3,
  "name": "Claude Profiles",
  "version": "0.1.0",
  "description": "Launch Chromium profiles per Claude account and switch claude.ai tab accounts.",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApsOB8/9r26rcuLGR+VHgUV6ZnwJueFmlMycFrCJkxny7BwsnxFty2Niy/hvaPzESDb/o+8KjsbxOlQlblje8HZnm6eTm60PDGqJ0xHjRjNF5L/M8OG5dh7rWz/MAp3BUpq5Nfa6YL4ukOxieWPOeVksWRHUiNa8P7eMQAC0sGyIBEq2GMVM4GCL2bpCOUoUN6NsCV10Ax8wvM7KFJX2NNuXBqUx2Fd0EqyyTrTFbRjsB4RRJcWayumYTuWxqfaNNqVi0s8YC/nPZphux2mIOUU22exiPrye/m/vzNGgA4RwId2/Qr1n7vzkVIKNzscn5jS+V9WHBmjtZCKUefwmb/QIDAQAB",
  "permissions": ["nativeMessaging", "cookies", "storage"],
  "host_permissions": ["https://claude.ai/*", "https://*.claude.ai/*"],
  "background": { "service_worker": "service-worker.js", "type": "module" },
  "action": { "default_popup": "popup.html", "default_title": "Claude Profiles" },
  "externally_connectable": {
    "matches": ["http://localhost/*", "http://127.0.0.1/*", "https://claude.ai/*", "https://*.claude.ai/*", "https://kanban.cute.engineer/*"]
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
| `profiles.launch` `{name,url?}` | native host | yes | yes |
| `accounts.list` | `lib/jars.js` → `{ok:true, accounts:[{label, savedAt, cookieCount}]}` | yes | yes |
| `accounts.save` `{label}` | jars → `{ok:true, account:{label,savedAt,cookieCount}}` | yes | **no** |
| `accounts.switch` `{label}` | jars → `{ok:true, reloadedTabs:number}` | yes | yes |
| `accounts.forget` `{label}` | jars → `{ok:true}` | yes | **no** |

- A disallowed external type gets `unsupported`.
- If `chrome.runtime.lastError` is set during native messaging, the reply is `{ok:false, error:{code:"native_host_unavailable", message:"Run: ccp install-host"}}`.
- Labels match `^[A-Za-z0-9 ._@-]{1,64}$`.

### 5.3 Cookie jars (`lib/jars.js`)

**Storage**

- Saved jars live in `chrome.storage.local` under the key `jars`, shaped as `{[label]: {savedAt, cookies: SavedCookie[]}}`.
- Cookie values exist only in that storage and in `chrome.cookies` calls. Never put them in `console.*`, in a response, or in the DOM.

**Exports** (pure, unit-tested in `extension/test/jars.test.js`)

- `isInfraCookie(name)`: true for `__cf_bm`, `cf_clearance`, `_cfuvid` and `__cflb`. These are left alone because they are tied to the browser and IP.
- `toSavedCookie(c)`: keeps `name`, `value`, `domain`, `path`, `secure`, `httpOnly`, `sameSite`, `expirationDate?` and `hostOnly`.
- `toSetDetails(saved)`:
  - `url` is `https://${domain without leading dot}${path}`;
  - `domain` is omitted when `hostOnly`;
  - `expirationDate` is omitted for session cookies;
  - `name`, `value`, `path`, `secure`, `httpOnly` and `sameSite` are carried over.

**Operations**

- **save:** `chrome.cookies.getAll({domain: "claude.ai"})`, filter out infra cookies, store. If no `sessionKey` cookie is present, fail with `invalid_request` and the message "Not signed in to claude.ai".
- **switch:**
  1. Remove every non-infra cookie returned by `getAll({domain: "claude.ai"})`.
  2. Set each saved cookie.
  3. Reload every tab from `chrome.tabs.query({url: ["https://claude.ai/*", "https://*.claude.ai/*"]})`; host permissions are enough for this.
  4. Return the count of reloaded tabs.
- **Default store only:** incognito is out of scope.

### 5.4 Popup

`popup.html`, `popup.js` and `popup.css`, at a 320 px width.

- **Profiles section:**
  - one row per profile, showing name, email, a running dot and a "Launch" button (or "Focus" when it is running);
  - the row for `current` is marked "this window";
  - an error from the native host shows inline with the message (e.g. "Run: ccp install-host").
- **claude.ai tab account section:**
  - a label input with a "Save current" button;
  - a list of saved jars, each with "Switch" and "Forget" buttons;
  - fixed helper text: "Changes the claude.ai login in this profile's tabs. Claude in Chrome keeps its own login."

### 5.5 Extension acceptance

- Loading the folder with `--load-extension` shows id `bkgjdpakjigjgdggfcckikppbjjcdkim`. The e2e test asserts this.
- `node --test 'extension/test/*.test.js'` passes: the infra filter, hostOnly domain omission, session-cookie expiration omission, and the URL built for `.claude.ai` versus `claude.ai`.
- No occurrence of `console.log(` that could contain cookie objects. `grep -n "value" extension/*.js extension/lib/*.js` shows value used only inside `toSavedCookie` and `toSetDetails`.

## 6. kanban integration (`/Users/aaronpierce/workspace/kanban`)

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
- **chromium:** the exact `buildLaunchArgs` output, with and without `url` and `extraArgs`. Also, `profiles.launch` with `url: "--foo"` and `url: "file:///etc/passwd"` gives `invalid_request`.
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

Run it with node directly; it exits non-zero on failure. It uses a temp `CCP_HOME` and `CCP_EXTRA_ARGS="--headless=new --remote-debugging-port=0"`, and never touches the user's Chromium profile.

1. `bin/ccp add smoke --email smoke@example.com --json` gives `ok`.
2. `bin/ccp launch smoke --json` gives `ok` with `running: true`.
3. Poll for `<udd>/DevToolsActivePort` for up to 15 s and read the port from its first line.
4. `GET http://127.0.0.1:<port>/json/list` must contain the service worker targets `chrome-extension://bkgjdpakjigjgdggfcckikppbjjcdkim/service-worker.js` and, when `claudeInChromeVersion` was non-null, one for `fcoeoabgfenejglbffodgkkbkcdhcgfn`.
5. Open the global `WebSocket` to our worker's `webSocketDebuggerUrl` and send `Runtime.evaluate` with `awaitPromise: true` and the expression `chrome.runtime.sendNativeMessage("engineer.cute.claude_profiles", {type: "profiles.list"})`. Assert `ok === true` and `current === "smoke"`. This proves the per-profile host manifest, the wrapper and the parent-process lookup work.
6. Evaluate the dispatcher with `{type: "accounts.list"}` and assert `{ok: true, accounts: []}`. Do not log in and do not set real cookies.
7. Kill the pid from `SingletonLock` with SIGTERM, wait up to 5 s, and check that `ccp status smoke --json` reports `running: false` (the stale lock is handled).
8. In a `finally` block, kill the process if it is still alive and remove the temp dir.

## 8. Security constraints (all components)

- **Network exposure:** the HTTP server binds `127.0.0.1` only, requires a bearer token (0600 file, timing-safe compare), checks the `Host` header, and sends no CORS headers.
- **Native host callers:** only our extension's origin is listed in `allowed_origins`. The host also checks `argv[1]`, and it does not allow add or remove.
- **Secrets:** cookie values, the token, OAuth tokens and `.claude.json` contents are never logged or returned. The launcher never reads `.claude.json` or the credentials in config dirs; it only stores the `configDir` path.
- **Read-only sources:** the user's real Chromium profile and its `NativeMessagingHosts` are read only, except for `install-host --chromium-default`, which the user opts into.
- **URL arguments:** URLs passed to Chromium are validated, so none can be read as a flag.
- **Children:** spawned children use `execFile` or `spawn` with argument arrays, never a shell string.
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
| Logging out of a saved session invalidates it server-side. | A switch then lands logged out. The popup shows "Signed out? Re-save this account." when, after a switch, `sessionKey` is absent. |
| Org policy `allow_claude_browser_extension` can disable Claude in Chrome per account. | Nothing to do. Claude Code reports it. |
| A stale `SingletonLock` survives a kill. | Treat a profile as running only when the host matches and `kill -0` succeeds. |
| Host→browser messages are capped at 1 MiB. | The host replaces oversized responses with an `internal` error. |
