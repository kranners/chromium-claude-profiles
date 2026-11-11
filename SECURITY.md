# Security

## What this tool holds

Claude Profiles stores the claude.ai session cookies of the accounts you save. Treat them like passwords: anyone who can read them can act as you on claude.ai. They live in the extension's local storage in your Chromium profile, and are protected by your operating system account, not by anything this project adds.

## Design choices

- Everything is local. The only network traffic is to claude.ai, to check each saved session.
- The bridge between `ccp` and the extension is a Unix socket (mode 0600, in a 0700 directory), not a network port. No debugging port is opened.
- The optional HTTP API binds to `127.0.0.1`, requires a bearer token stored in a 0600 file, checks the `Host` header and sends no CORS headers.
- The native messaging host only accepts this extension's origin.
- Cookie values, the token and OAuth tokens are never logged, printed or returned, apart from the one-off `ccp migrate` import, which moves cookies between old profiles and the main browser through the local sockets.
- `accounts.json`, read by monitors, holds labels, emails, states and expiry times only.
- Auto-swap remembers only which of your own account labels owns which claude.ai link (kind and id), in the extension's storage. It requests no extra permission, and the confirmation banner it may inject into a claude.ai tab can send exactly one message, "turn auto-swap on or off".
- `ccp` can ask the extension to save the account that is signed in now and to open the sign-in page. It cannot read a cookie out, and sign-in saves the account signed in now before it clears anything, refusing when it cannot check that session, so nothing is signed out by accident.
- Child processes are started with argument arrays and, for sign-back-in, a restricted environment.

## Things to know

- Anything running as your user can use `ccp` to switch accounts. That is the point (agents can switch for you), but it means a malicious program running as you could too.
- The optional sign-back-in helper lets Claude Code drive a browser session on your mailbox to open a login email. Email content is treated as data, but an attacker who can send you a crafted email could in principle try to steer it. Leave it off if that worries you.
- Loading an unpacked extension means you are running the code in your checkout. Review changes before you `git pull`.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"), or contact the maintainer through the email on their GitHub profile. Include steps to reproduce and the version (`extension/manifest.json`). Expect an acknowledgement within a week.
