# Contributing

Thanks for helping. This is a small project; issues and pull requests are welcome.

## Setup

You need Node 24 and git. There is no npm install and no build step.

```sh
git clone https://github.com/kranners/chromium-claude-profiles.git
cd chromium-claude-profiles
node --test 'launcher/test/*.test.ts' 'extension/test/*.test.js'
```

`launcher/test/pilotMigrate.test.ts` also needs bash, git and ps.

An end-to-end smoke test starts a headless Chromium on a scratch user-data directory and never touches your own browser:

```sh
CCP_CHROMIUM=<path to chromium> node tests/e2e/smoke.ts
```

(Off a Mac, also set `CCP_E2E_EXTRA_ARGS=--no-sandbox`.)

## Ground rules

- Read [docs/CONTRACT.md](docs/CONTRACT.md) first. If you change behaviour it describes, update it in the same pull request.
- Cookie values, the API token and any credentials must never be logged, printed or returned. Add a test when you touch that code.
- Spawn children with argument arrays, never shell strings. Validate any URL passed to Chromium.
- Keep the launcher dependency-free (Node standard library only).
- Keep public files free of personal or employer details: no real email addresses, account labels, hostnames or company names in code, tests, docs or fixtures. Use `example.com`.
- After changing extension code, press **Reload extension** before testing by hand.

## Pull requests

Small and focused, with tests, and a description of what changed and why. Mention what you ran.
