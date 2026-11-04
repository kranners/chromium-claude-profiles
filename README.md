# chromium-claude-profiles

Keep every Claude account in your one main Chromium, and let agents switch accounts and open claude.ai links there.

## Usage

`launcher/bin/ccp` needs only Node 24 (no npm, no build). Link it onto your `PATH` if you like:

```sh
ln -s "$PWD/launcher/bin/ccp" ~/.local/bin/ccp

ccp list [--json]                       saved accounts, which is active, last known status
ccp status [<account>] [--json]         checks every saved session now
ccp launch <account> [--url U] [--json] switch your main Chromium to the account, then open U
ccp switch <account> [--json]           switch your main Chromium to the account, opening nothing
ccp open-for <claude.ai url> [--json]   open a link in whichever account can see it
ccp migrate [--json]                    move the old per-account profiles' sessions into the main Chromium
ccp serve [--port N]
ccp install-host [--chromium-default]
ccp add|remove|env ...                  old per-account profiles only
```

`<account>` is a saved account's label, its email, the short name `ccp list` shows, or the name of an old profile with that email.

### One Chromium, every account

1. `ccp install-host --chromium-default`
2. In `chrome://extensions` of your main Chromium, turn on Developer mode, choose Load unpacked and pick `extension/`.
3. Sign in to claude.ai, open Claude Profiles and save the account under a label.
4. Choose "Sign in another account", sign in, and save that one too. Never log out of a saved
   account: logging out revokes its session, and switching to it then fails and leaves you where you were.
5. Run `ccp migrate` once if you used the old per-account profiles (below).

The extension keeps one cookie jar per account and holds a native messaging connection open to the
launcher, which serves it on a private socket, `~/.config/chromium-claude-profiles/run/main.sock`
(directory 0700, socket 0600). `ccp launch`, `ccp open-for`, `ccp list` and `ccp status` talk to the
browser through it, so anything running as you, an agent over ssh included, can switch accounts and open
links in the browser you already keep signed in. No debugging port is opened and no extra browser
process or `--user-data-dir` is started. When the main Chromium is closed, `ccp launch` starts it, plain,
and waits for the extension to connect.

**Limits.** Chromium keeps one cookie store per profile, not per tab, so only one claude.ai account is
active in the browser at a time. Switching reloads every claude.ai tab into the new account, and two agents
asking for different accounts at once take turns: each `ccp launch` switches on demand and the last one
wins. The extension has no per-tab cookie scope, so a second window does not give two accounts at once
either. You can switch at will from the popup; agents switch the same way through `ccp`. Claude in Chrome keeps its own single login in this browser, so only Claude Code on that account
pairs with it; agents on other accounts drive through `ccp` and see the page by other means.

`ccp open-for` tries the active account first, then every other saved account not known to be signed
out, and keeps the first one whose page neither says it "couldn't be found" nor sends it to sign in after
8 seconds. If none can see it, it closes its tab, switches back and says so. The page check is a heuristic
over the page's text.

After pulling a new version, press "Reload extension" in the popup. Chromium keeps serving the old
service worker to an extension loaded unpacked across restarts and version bumps; the popup itself
always loads fresh from disk. The popup's Agents line says whether `ccp` can reach the browser.

The popup opens instantly because an offscreen document keeps the extension's process alive; without
it a busy machine spends about a second starting a renderer for every open. "Launcher answered in N ms"
confirms the native host is working.

### Moving off the old per-account profiles

On a Mac that still runs the old profiles, `scripts/pilot-migrate.sh` does the whole move in one safe,
repeatable command (`--dry-run` prints the plan): it updates this checkout, installs the host, checks the
extension in the main Chromium, runs `ccp migrate`, quits the old profile browsers and lists who needs a
sign-in. See `scripts/README.md`.

`ccp migrate` starts each old profile under `~/.config/chromium-claude-profiles/profiles/` headless
(or uses it if it is already open), reads its live claude.ai session through its own extension, and saves
it into the main Chromium's jar for that email, unless the main Chromium already has a working session
for it. Then it stops the profiles it started and checks every account. It prints each profile's outcome
and the accounts that still need you to sign in once in the main Chromium; it never prints cookies, never
signs anyone in or out, and never deletes the old profile folders, which you can delete yourself. A
profile whose extension still runs an old service worker says so; open it once, press Reload extension,
and run `ccp migrate` again. `ccp launch` no longer starts old profiles.

### Session expiry

Every saved account shows "Signed in", "Expires soon" (its session cookie expires within 3 days),
"Signed out" (revoked, or past its expiry) or "Couldn't check". `ccp status` checks them all now, and
the extension checks hourly and writes the result, labels, emails, states and expiry times only, to
`~/.config/chromium-claude-profiles/accounts.json` (0600), which `ccp list` falls back to while the
browser is closed and which a monitor can read.

### Signed-out accounts

The popup checks every saved account when it opens, and hourly in the background, without switching
to it. Each account shows "Signed in", "Signed out" or "Couldn't check", and the toolbar badge counts
the signed-out ones.

"Sign back in to signed-out accounts" has Claude Code drive this browser's Claude in Chrome through
each account's emailed login link. It needs:

- Claude in Chrome signed in in this browser;
- a Claude Code config dir signed in to that same account: one listed in `relogin.json`'s `driverDirs`,
  an old profile's `--config-dir`, or any subdirectory of a directory in `CCP_DRIVER_DIRS`;
- `~/.config/chromium-claude-profiles/relogin.json`, telling it where each account's mail is read,
  and optionally which config dirs and which `claude` to drive with, since the main Chromium starts
  the launcher with its own environment, not your shell's:

```json
{"mailboxes": [
  {"match": "@example.com", "url": "https://mail.example.com/?u={email}#search", "priority": 10},
  {"match": "me@example.org", "url": "https://mail.example.org/"}
],
 "driverDirs": ["/Users/me/.claude"],
 "claude": "/Users/me/.local/bin/claude"}
```

`@domain` matches that domain and its subdomains; anything else matches one address. `{email}` is
replaced with the address, URLs must be https, and higher `priority` goes first. Accounts with no
mailbox are skipped. While it runs, the popup lists the pending accounts with a Cancel button, which
also stops Claude Code. It ends when Claude Code exits, or gives up after 20 minutes (6 per account beyond three), and puts back
the account you were using. Each run logs to
`~/.config/chromium-claude-profiles/logs/relogin-<time>.log`. It stops rather than solve a CAPTCHA.

The launcher runs inside Chromium, so `CCP_CLAUDE` and `CCP_DRIVER_DIRS` only reach it from the
environment Chromium started with; `relogin.json`'s `claude` and `driverDirs` work however it started.

### Claude in Chrome

Claude Code and Claude in Chrome meet on the account's cloud bridge channel, not through the native host
(Claude Code 2.1.292). In the one-browser model, Claude in Chrome is signed in to one account, and
`claude --chrome` pairs with it only from a config dir on that same account.

### HTTP API

`ccp serve` listens on `127.0.0.1:47321` (`--port` or `CCP_PORT` to change). Every route except `GET /v1/health` needs `Authorization: Bearer $(cat ~/.config/chromium-claude-profiles/token)`.

| Route | Does |
|---|---|
| `GET /v1/health` | version |
| `GET /v1/accounts` | `ccp list` |
| `GET /v1/accounts/:account` | `ccp status <account>` |
| `POST /v1/accounts/:account/open` `{url?}` | `ccp launch <account> --url` |
| `POST /v1/open-for` `{url}` | `ccp open-for` |
| `GET /v1/profiles` | old profiles |
| `POST /v1/profiles` `{name, email?, configDir?}` | add |
| `GET /v1/profiles/:name` | status |
| `DELETE /v1/profiles/:name[?keepData=1]` | remove |
| `POST /v1/profiles/:name/launch` `{url?}` | same as `/v1/accounts/:name/open` |
| `GET /v1/profiles/:name/env` | `CLAUDE_CONFIG_DIR` for the profile |

### Environment

| Variable | Default |
|---|---|
| `CCP_HOME` | `~/.config/chromium-claude-profiles` |
| `CCP_CHROMIUM` | `/Applications/Chromium.app/Contents/MacOS/Chromium`, started plain when the main Chromium is closed |
| `CCP_CLAUDE_EXT_SOURCE` | Claude in Chrome's folder in the default Chromium profile (read only) |
| `CCP_EXTENSION_DIR` | `extension/` in this repository |
| `CCP_EXTRA_ARGS` | extra Chromium flags, split on whitespace |
| `CCP_NODE` | the Node binary `bin/ccp` runs |
| `CCP_CLAUDE` | `/opt/homebrew/bin/claude`, the Claude Code that drives "sign back in" |
| `CCP_DRIVER_DIRS` | none; colon-separated directories whose subdirectories are Claude Code config dirs "sign back in" may drive with |

### Tests

```sh
node --test 'launcher/test/*.test.ts' 'extension/test/*.test.js'   # pilotMigrate.test.ts needs bash, git and ps
node tests/e2e/smoke.ts    # CCP_CHROMIUM=<chromium> CCP_E2E_EXTRA_ARGS=--no-sandbox off a Mac
```

The smoke test starts a headless Chromium on a scratch user-data-dir laid out like the main one, loads
the extension, and checks `ccp list`, `launch`, `open-for` and `migrate` through the bridge. It never
touches your own Chromium.
