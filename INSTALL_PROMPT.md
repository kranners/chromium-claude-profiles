# Install Claude Profiles with one prompt

Paste this into Claude Code (or any coding agent that can run shell commands) on the computer you want to set up. It installs everything and walks you through saving each of your Claude accounts.

<!-- INSTALL_PROMPT_START -->
```text
Install Claude Profiles on this computer and set up all of my Claude accounts.
Read https://github.com/kranners/chromium-claude-profiles/blob/main/INSTALL_PROMPT.md and follow the "Steps for the agent" section exactly.
```
<!-- INSTALL_PROMPT_END -->

That is the whole prompt. The agent reads the steps below, so they stay current without you re-copying anything.

**Prefer to do it yourself?** Run `curl -fsSL https://raw.githubusercontent.com/kranners/chromium-claude-profiles/main/install.sh | sh`, load the extension as step 3 below says, then use `ccp save` as in step 4.

## What it does and does not do

- macOS and Linux, with Chromium, Google Chrome or Brave. Windows is not supported.
- Needs Node 24 or newer and git. It tells you if either is missing and installs nothing without your yes.
- No sudo. It writes only inside your home folder: a checkout in `~/.local/share/chromium-claude-profiles`, a `ccp` link in `~/.local/bin`, settings in `~/.config/chromium-claude-profiles`, and one native messaging host file in your browser's own folder.
- It never edits your shell startup files, never signs any account out, and never reads or prints a cookie or token.
- Safe to run again: every step checks first and skips what is done.
- Loading the extension is a manual step of three clicks. Chrome and Chromium do not allow a script to load an unpacked extension into a browser you already use.

## Steps for the agent

You are installing Claude Profiles for the user. Follow these steps in order and tell the user in one or two plain sentences what you are doing at each. Do not use sudo. Do not read, print or copy cookies, tokens or anything under the browser's profile folder. Never log out of a claude.ai account: logging out revokes the saved session. Stop and ask the user before doing anything these steps do not list.

1. **Install.** Run `curl -fsSL https://raw.githubusercontent.com/kranners/chromium-claude-profiles/main/install.sh | sh` and read its output.
   - Exit code 4 means a prerequisite is missing (Node 24 or newer, git, or a Chromium-based browser). Tell the user exactly what is missing and offer the install command it printed. Run it only if they say yes, then run step 1 again.
   - Exit code 3 means everything is installed except loading the extension. Go to step 2.
   - Exit code 0 means it is already working. Go to step 4.
   - Any other failure: show the user the last lines of output and stop.
2. **Load the extension.** Tell the user, in their browser (the one named in the output): open `chrome://extensions`, switch on Developer mode (top right), choose Load unpacked, and pick the folder the installer printed (its path is already on their clipboard). They should keep the browser open. Wait for them to say it is done.
3. **Check.** Run `ccp doctor` (use `~/.local/bin/ccp doctor` if `ccp` is not on PATH). If it says the extension is not connected, ask the user to press Reload extension in the Claude Profiles popup (the toolbar icon, under the puzzle-piece menu if hidden) and run it again. Repeat until its checks all say `ok`.
4. **Save each account.** Ask the user which Claude accounts they use and what short label they want for each (for example `personal`, `work`). Run `ccp list` first to see what is already saved.
   - For the account signed in right now: ask the user to confirm that claude.ai is open and signed in to the account they name, then run `ccp save <label>`.
   - For each further account: run `ccp sign-in-another` (it opens the claude.ai sign-in page and only clears the local session, it does not log out), ask the user to sign in to the next account in the browser and tell you when done, then run `ccp save <label>`. If it refuses because the current account is not saved yet, run `ccp save` for that one first.
   - After each save run `ccp list` and confirm the new account shows as signed in.
5. **Finish.** Run `ccp list` once more and tell the user which accounts are saved. Then tell them:
   - Auto-swap is built in. The first time they open a claude.ai link that belongs to one account while another is active, a small banner on the page asks them to turn it on once. After that, links to code sessions, chats, projects, artifacts and shared pages open in the right account on their own.
   - Only one claude.ai account is active in the browser at a time, and switching reloads every open claude.ai tab.
   - They can turn auto-swap off, or exclude one link, in the Claude Profiles popup.
   - If an account shows as signed out later, they sign in to it again and run `ccp save <label>` with the same label.

If anything fails and you cannot fix it with the steps above, show the user the output of `ccp doctor` and stop. Do not improvise changes to their browser or system.
