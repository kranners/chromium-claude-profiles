# chromium-claude-profiles

Run several Claude accounts side by side in Chromium, each in its own profile with Claude in Chrome.

## Usage

`launcher/bin/ccp` needs only Node 24 (no npm, no build). Link it onto your `PATH` if you like:

```sh
ln -s "$PWD/launcher/bin/ccp" ~/.local/bin/ccp
```

```
ccp list [--json]
ccp add <name> [--email E] [--config-dir D] [--json]
ccp remove <name> [--keep-data] [--json]
ccp launch <name> [--url U] [--json]
ccp status [<name>] [--json]
ccp env <name>
ccp serve [--port N]
ccp install-host [--chromium-default]
```

Each profile is its own Chromium `--user-data-dir` under `~/.config/chromium-claude-profiles/profiles/<name>`, launched with an unpacked copy of Claude in Chrome and the Claude Profiles extension. One profile per Claude account: `add` refuses an email another profile already uses, because two browsers on one account share a bridge channel.

### Switching claude.ai accounts in your main profile

1. `ccp install-host --chromium-default`
2. In `chrome://extensions`, turn on Developer mode, choose Load unpacked and pick `extension/`.
3. Sign in to claude.ai, open Claude Profiles and save the account under a label.
4. Choose "Sign in another account", sign in, and save that one too. Never log out of a saved
   account: logging out revokes its session, and switching to it then fails and leaves you where you were.

Switching only changes the claude.ai login in this profile's tabs. Claude in Chrome keeps its own
login, so run one `ccp` profile per account for parallel Claude in Chrome instances.

After pulling a new version, press reload on the extension in `chrome://extensions`. Chromium keeps
serving the old service worker to an extension loaded with `--load-extension` across restarts and
version bumps, so `ccp launch` profiles need the same reload.

### Pairing Claude Code with a profile

```sh
ccp add work --email me@example.com --config-dir ~/.claude-work
ccp launch work
eval "$(ccp env work)" && claude --chrome
```

Sign Claude in Chrome into the same account inside that profile once. That sign-in is the pairing: Claude Code and Claude in Chrome meet on the account's cloud bridge channel, not through the native host. This holds for Claude Code 2.1.292; a version that pairs through the local socket pool instead would mix accounts.

If you put two profiles on one account by hand, Claude Code asks which browser to use; `select_browser` or `CLAUDE_CHROME_PAIRED_DEVICE_ID` picks one.

### HTTP API

`ccp serve` listens on `127.0.0.1:47321` (`--port` or `CCP_PORT` to change). Every route except `GET /v1/health` needs `Authorization: Bearer $(cat ~/.config/chromium-claude-profiles/token)`.

| Route | Does |
|---|---|
| `GET /v1/health` | version |
| `GET /v1/profiles` | list |
| `POST /v1/profiles` `{name, email?, configDir?}` | add |
| `GET /v1/profiles/:name` | status |
| `DELETE /v1/profiles/:name[?keepData=1]` | remove |
| `POST /v1/profiles/:name/launch` `{url?}` | launch |
| `GET /v1/profiles/:name/env` | `CLAUDE_CONFIG_DIR` for the profile |

### Environment

| Variable | Default |
|---|---|
| `CCP_HOME` | `~/.config/chromium-claude-profiles` |
| `CCP_CHROMIUM` | `/Applications/Chromium.app/Contents/MacOS/Chromium` |
| `CCP_CLAUDE_EXT_SOURCE` | Claude in Chrome's folder in the default Chromium profile (read only) |
| `CCP_EXTENSION_DIR` | `extension/` in this repository |
| `CCP_EXTRA_ARGS` | extra Chromium flags, split on whitespace |
| `CCP_NODE` | the Node binary `bin/ccp` runs |

### Tests

```sh
node --test 'launcher/test/*.test.ts' 'extension/test/*.test.js'
node tests/e2e/smoke.ts
```
