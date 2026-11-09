# Claude Profiles

Keep several claude.ai accounts in one Chromium-based browser and switch between them in a click. Open a claude.ai link and the extension switches to the account that owns it. Scripts and coding agents can do the same through a small `ccp` command.

<p align="center"><img src="assets/icon.svg" width="96" alt="Claude Profiles icon"></p>

## Why

If you use more than one Claude account (a personal one and one or two for work, or spare accounts for when a usage limit runs out), the browser gives you two bad choices: log out and in again every time, or run a separate browser profile per account and keep each one signed in to everything else too.

Claude Profiles saves each account's claude.ai session and swaps between them inside your normal browser. Everything else you are signed in to stays as it is.

## What you get

- **A popup** listing your saved accounts with their status (Signed in, Expires soon, Signed out), a Switch button for each, and a toolbar badge counting signed-out accounts.
- **Auto-swap for links.** Open a claude.ai link to a Claude Code session, chat, project, artifact or shared page, and Claude Profiles finds the saved account that can see it, switches to it and reloads the tab. It remembers the answer, never loops, and has an off switch and a per-link opt-out. See [docs/AUTO_SWAP.md](docs/AUTO_SWAP.md).
- **The `ccp` command** for scripts and agents: `ccp list`, `ccp status`, `ccp switch <account>`, `ccp launch <account> --url <url>`, `ccp open-for <url>`, `ccp save <label>`, `ccp doctor`.
- **Session checks:** every saved account is checked when you open the popup and once an hour, without switching to it.
- **Sign back in:** an optional helper that signs expired accounts back in through their emailed login link (see [docs/ONBOARDING.md](docs/ONBOARDING.md)).

## Install in about a minute

You need macOS or Linux, Chromium, Google Chrome or Brave, [Node 24](https://nodejs.org) or newer, and git. Windows is not supported. No sudo is used anywhere.

**One prompt.** Open Claude Code (or another coding agent that can run shell commands) and paste the prompt in [INSTALL_PROMPT.md](INSTALL_PROMPT.md). It installs everything, asks you to load the extension (the one step no script can do for you), then walks you through saving each of your accounts.

**By hand.**

```sh
curl -fsSL https://raw.githubusercontent.com/kranners/chromium-claude-profiles/main/install.sh | sh
```

`install.sh` finds Node, clones the repository into `~/.local/share/chromium-claude-profiles`, links `ccp` into `~/.local/bin`, installs the native messaging host for your browser and runs `ccp doctor`. It is safe to run again. Pass `--browser chromium|chrome|brave` if you have more than one, or `--dry-run` to see what it would do.

Then load the extension: in your browser open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick the `extension/` folder inside the checkout (the installer prints the path and copies it to your clipboard). Open the Claude Profiles popup: the Agents line should say `ccp` can reach the browser. Run `ccp doctor` any time to check.

Next, save your accounts: see [docs/ONBOARDING.md](docs/ONBOARDING.md). In short: sign in to claude.ai, run `ccp save personal`; run `ccp sign-in-another`, sign in to the next account, run `ccp save work`; repeat.

## Limits, plainly

- **One account is active at a time.** The browser keeps cookies per profile, not per tab, so every claude.ai tab is on the same account. Two windows do not give you two accounts at once. A tab for account A and a tab for account B cannot both work at the same moment.
- **Switching reloads your claude.ai tabs** into the new account, auto-swap included. Unsent text in those tabs can be lost, so finish your message first.
- **Agents take turns.** If two scripts ask for different accounts at the same moment, the last switch wins.
- **Claude in Chrome keeps its own login.** Claude Profiles changes the claude.ai website session only. It does not change which account the Claude in Chrome extension is signed in to.
- **Never log out of a saved account.** Logging out revokes the session on Anthropic's side, and the saved copy stops working. To use another account, use "Sign in another account" in the popup or `ccp sign-in-another`, which clears the tabs locally without logging out.
- Developer-mode (unpacked) extensions are not updated automatically. After `git pull`, press **Reload extension** in the popup.
- Chrome's own `--load-extension` flag no longer works in branded Chrome, which is why the extension has to be loaded by hand there.

## Privacy

Everything stays on your machine. Saved sessions live in the extension's local storage in your browser profile, and auto-swap remembers only which of your own account labels owns which claude.ai link. The extension talks to `ccp` over a Unix socket in `~/.config/chromium-claude-profiles/run/` (directory mode 0700, socket 0600), so only your own user can use it. The optional HTTP API listens on `127.0.0.1` only and needs a bearer token. No debugging port is opened, cookie values are never logged or printed, and nothing is sent to any server other than claude.ai itself, to check each session. No analytics, no telemetry. See [SECURITY.md](SECURITY.md).

The extension requests host access to `claude.ai` only, plus the `cookies`, `nativeMessaging`, `storage`, `offscreen`, `alarms`, `scripting` and `declarativeNetRequestWithHostAccess` permissions. It does not ask for `tabs` or access to any other site. [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) says what each is for.

## Uninstall

1. Remove the extension in `chrome://extensions`. This deletes the saved sessions.
2. `rm ~/.local/bin/ccp`
3. Delete `~/.config/chromium-claude-profiles/` and the native messaging manifest `engineer.cute.claude_profiles.json` from your browser's `NativeMessagingHosts` folder (macOS: under `~/Library/Application Support/`, in `Chromium`, `Google/Chrome` or `BraveSoftware/Brave-Browser`; Linux: under `~/.config/`, in `chromium`, `google-chrome` or `BraveSoftware/Brave-Browser`).
4. Delete `~/.local/share/chromium-claude-profiles` (or wherever you cloned it).

## More

- [Install prompt](INSTALL_PROMPT.md)
- [Onboarding, step by step](docs/ONBOARDING.md)
- [Auto-swap](docs/AUTO_SWAP.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [How it works](docs/HOW-IT-WORKS.md)
- [Build contract](docs/CONTRACT.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Command reference

```
ccp doctor [--json]                     check Node, the native host and the extension; say what to do next
ccp list [--json]                       saved accounts, which is active, last known status
ccp status [<account>] [--json]         check every saved session now
ccp save <label>                        save the account signed in now under a label
ccp sign-in-another                     open the sign-in page for the next account (does not log out)
ccp launch <account> [--url U]          switch to the account, then open U
ccp switch <account>                    switch to the account, opening nothing
ccp open-for <claude.ai url>            open a link in whichever account can see it
ccp migrate                             import sessions from old per-account profiles
ccp serve [--port N]                    local HTTP API on 127.0.0.1:47321
ccp install-host [--browser B]          install the native messaging host (B is chromium, chrome or brave)
```

`<account>` is a saved account's label, its email, or the short name `ccp list` shows. `ccp add`, `remove` and `env` only apply to the older per-account-profile mode.

## Website

<https://kranners.github.io/chromium-claude-profiles/>

## Not affiliated with Anthropic

Claude Profiles is an independent, unofficial open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic. The crab silhouettes in the icon are an original illustration inspired by the Claude Code mascot; if Anthropic asks for a change, we will change it.

## Licence

[MIT](LICENSE).
