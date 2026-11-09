# How it works

A short tour. The full spec is [CONTRACT.md](CONTRACT.md).

## The pieces

- **The extension** (`extension/`, Manifest V3). Holds the saved accounts, switches between them and checks their sessions. It has a popup and a service worker.
- **The launcher** (`launcher/`, TypeScript run directly by Node 24, no build step). Provides the `ccp` command, the optional local HTTP API and the native messaging host.
- **The bridge.** The extension opens a native messaging connection to the launcher. The host process that Chromium starts for it listens on a Unix socket, `~/.config/chromium-claude-profiles/run/main.sock`. `ccp` commands send one JSON request over that socket and read one JSON reply. File permissions (directory 0700, socket 0600) are the only authentication, so only your own user's processes can switch accounts.

```
ccp / agent  ->  main.sock  ->  native host  ->  extension  ->  chrome.cookies
```

## An account is a cookie jar

Saving an account copies its claude.ai cookies (except Cloudflare's, which are tied to the browser and IP) into the extension's `chrome.storage.local`, along with the account's email and last check result.

**Switching** does this, in a queue so only one switch runs at a time:

1. Check the outgoing session, and write its current cookies back into its jar so refreshed session keys are not lost.
2. Remove the claude.ai cookies, then set the saved ones.
3. Check the new session. If it is revoked, put the old cookies back and report the failure.
4. Reload every claude.ai tab.

Cookie values exist only in extension storage and in `chrome.cookies` calls. They are never logged or put in the page.

## Why only one account at a time

Cookies belong to the browser profile, not the tab, so every claude.ai tab shares them. Rewriting cookies per tab was ruled out: claude.ai's front end also reads non-HttpOnly cookies from the shared store, which would mix accounts inside a tab.

## Checking sessions

To check a jar without touching your live cookies, the extension adds a temporary `declarativeNetRequest` rule that sets the `cookie` header for one request to `https://claude.ai/api/account`, fetches it with credentials omitted, and removes the rule. A 200 with an email is "ok"; 401, or 403 without a Cloudflare mitigation header, is "revoked"; anything else is "unknown". This runs when the popup opens and hourly (`alarms`).

## Opening a link under the right account

`open-for` tries the active account first, then the other saved accounts not known to be signed out. For each it opens the URL in one tab and reads the page text (`scripting`) until it decides: `/login` or `/magic-link` means signed out, "couldn't be found" means not found, and 8 seconds with neither means found. If no account can see the page it closes its tab and switches back.

## Auto-swap

The service worker watches tab updates for claude.ai addresses of the form `/chat/<id>`, `/code/<id>`, `/project/<id>`, `/artifacts/<id>`, `/share/<id>` and a few more. After a short debounce it asks which saved account owns the link: a remembered owner first, then the active account, then each other saved account that is not signed out. Each candidate is judged from the page text exactly as `open-for` does, with a stricter set of "missing page" phrases. The decision logic is pure and unit tested (`extension/lib/autoswap-logic.js`); the glue that talks to the browser is `extension/lib/autoswap.js`. Loops are prevented by ignoring the reloads a switch causes for 20 seconds, by a per-tab cooldown, by not running while another account operation is in progress, and by remembering links no account could see for ten minutes. [AUTO_SWAP.md](AUTO_SWAP.md) has the details and the limits.

## Why each permission

- `cookies`, host access to `claude.ai`: read and set the session cookies.
- `storage`: keep the saved jars.
- `nativeMessaging`: talk to `ccp`.
- `offscreen`: keep the extension's process warm so the popup opens instantly.
- `alarms`: the hourly session check.
- `scripting`: read page text to classify a link, and show the one-off auto-swap confirmation banner.
- `declarativeNetRequestWithHostAccess`: the session probe described above.

## State on disk

Under `~/.config/chromium-claude-profiles/` (mode 0700): `accounts.json` (labels, emails, states and expiry times, never cookies, mode 0600), `token` (for the HTTP API), `run/` (sockets), `logs/` (sign-back-in logs), and optionally `relogin.json`. The saved sessions themselves are in Chromium's extension storage.

## Claude in Chrome

Claude Code and Claude in Chrome pair through the account's cloud channel, not through this extension. Claude in Chrome keeps its own login, so switching claude.ai's web session does not change which account it uses.
