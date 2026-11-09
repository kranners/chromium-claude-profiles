# Onboarding

A step-by-step guide to getting every one of your Claude accounts into Claude Profiles. Allow about five minutes for the first account and one minute for each after that.

## Before you start

- A Chromium-based browser (Chromium, Chrome or Brave) with the extension loaded and `install.sh` run (see the [README](../README.md)). `ccp doctor` tells you if anything is missing.
- Open the Claude Profiles popup. The **Agents** line should say `ccp` can reach this browser, with a launcher time in milliseconds. If it shows an error such as "Run: ccp install-host", see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
- Have the sign-in method for each account to hand (usually an emailed login link or a Google sign-in).

## Save your first account

1. Go to <https://claude.ai> in this Chromium and sign in to your first account.
2. Open the Claude Profiles popup (puzzle-piece menu, then Claude Profiles; pin it if you like).
3. Type a short label such as `personal` and press **Save current**.
4. The account appears in the list with a green **Signed in** chip.

## Add each further account

1. In the popup press **Sign in another account**. This clears the claude.ai cookies from the browser *locally*; it does not log the saved account out.
2. Your claude.ai tabs reload to the sign-in page. Sign in to the next account.
3. Open the popup, type a label and press **Save current**.
4. Repeat for each account.

### The same thing from a terminal

```sh
ccp save personal            # claude.ai is signed in to the first account
ccp sign-in-another          # opens the sign-in page; sign in to the next account
ccp save work
ccp list
```

`ccp sign-in-another` refuses while the account signed in now is not saved, so you cannot lose a session by accident. A coding agent can drive exactly this; it is what the install prompt does.

> **Never use claude.ai's own "Log out" button on a saved account.** Logging out revokes the session on Anthropic's servers, so the saved copy stops working and you would have to sign in again. Always use **Sign in another account** or **Switch**.

## Auto-swap

Once you have two or more accounts saved, opening a claude.ai link to a Claude Code session, chat, project, artifact or shared page switches to the account that owns it. The first time, a small banner on the page asks you to turn it on. See [AUTO_SWAP.md](AUTO_SWAP.md) for what it does and does not do.

## Switch accounts

- From the popup: press **Switch** next to an account. Your claude.ai tabs reload into it.
- From a terminal: `ccp switch <label>`.
- Open a link under the right account: `ccp open-for <claude.ai url>` tries the active account first and then each other saved account, and keeps the first one whose page loads rather than saying "couldn't be found" or sending you to sign in. If none can see it, it closes its tab, switches back and tells you.

Check what you have with `ccp list` (saved accounts and which is active) or `ccp status` (checks every session now).

## Keep sessions healthy

- Each account shows **Signed in**, **Expires soon** (within 3 days of the session cookie expiring), **Signed out**, or **Couldn't check**.
- The toolbar badge counts signed-out accounts.
- When an account is **Signed out**, switch to it and sign in again (or use the helper below), then press **Save current** with the same label.

### Optional: automatic sign back in

If you use Claude Code, the popup can offer **Sign back in to signed-out accounts**. Claude Code drives Claude in Chrome through each account's emailed login link. It needs Claude in Chrome signed in in this browser, a Claude Code config directory signed in to that same account, and a file `~/.config/chromium-claude-profiles/relogin.json` saying where each account's mail is read:

```json
{"mailboxes": [
  {"match": "@example.com", "url": "https://mail.example.com/?u={email}#search", "priority": 10},
  {"match": "me@example.org", "url": "https://mail.example.org/"}
],
 "driverDirs": ["/Users/me/.claude"],
 "claude": "/Users/me/.local/bin/claude"}
```

`@domain` matches that domain and its subdomains, anything else matches one address, `{email}` is replaced with the address, URLs must be https, and a higher `priority` goes first. Accounts with no matching mailbox are skipped. While it runs, the popup lists the pending accounts with a Cancel button. It gives up after 20 minutes (more for many accounts), logs to `~/.config/chromium-claude-profiles/logs/`, and stops rather than solve a CAPTCHA.

Only enable this if you are comfortable with Claude Code reading the newest sign-in email in that mailbox: it is driving a real browser session on your mail site. Mail content is treated as data, but see [SECURITY.md](../SECURITY.md).

## Coming from the older per-account profiles?

If you used an earlier version that kept one Chromium profile per account, run the migration script in `scripts/` with `--dry-run` to see the plan, then again without the flag. It never logs anyone out and never deletes the old profile folders. Most people will never need it.
