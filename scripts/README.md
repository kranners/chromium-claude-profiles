# pilot-migrate.sh

One command that moves a Mac from the old one-browser-per-account profiles onto the one main Chromium:

```sh
~/workspace/chromium-claude-profiles/scripts/pilot-migrate.sh --dry-run   # prints the plan, changes nothing
~/workspace/chromium-claude-profiles/scripts/pilot-migrate.sh             # does it
```

In a fresh shell, before the checkout has the script, run it straight from main:

```sh
git -C ~/workspace/chromium-claude-profiles pull --ff-only && ~/workspace/chromium-claude-profiles/scripts/pilot-migrate.sh
```

It runs as you, with no sudo, and touches only your home and your Chromium:

1. Fast-forwards `~/workspace/chromium-claude-profiles` to `origin/main` (refusing local changes or a branch other than `main`) and links `~/.local/bin/ccp` to it, leaving any other `ccp` there alone.
2. Runs `ccp install-host --chromium-default`, which writes ccp's native messaging host manifest for the main Chromium.
3. Checks the Claude Profiles extension is loaded in the main Chromium and answering `ccp`, waiting up to 90 s for it to reconnect. If it is not loaded, it stops (exit 3) with the one hand step: `chrome://extensions`, Developer mode, Load unpacked, pick `extension/`. If it is loaded but runs old code, it stops and asks you to press Reload extension in its popup.
4. Runs `ccp migrate`, which reads each old profile's live claude.ai session through that profile's own extension and saves it into the main Chromium, unless the main Chromium already has a working session for it. Cookies are never printed.
5. Quits each old profile browser still running on a folder under `~/.config/chromium-claude-profiles/profiles/`, matched by its `--user-data-dir`, never the main Chromium; a profile whose session could not be read is left running so a re-run can try again.
6. Prints every account's state and session expiry (`ccp status`) and the accounts that need one sign-in in the main Chromium.

It never logs an account out (that revokes the session), never signs anyone in and never deletes the old profile folders; delete those yourself once you are happy.
It is safe to re-run: every step checks first and skips what is already done. Exit 0 when done, 3 when it stopped for a hand step it printed, 1 on an error.
`launcher/test/pilotMigrate.test.ts` runs it against a fake home.
