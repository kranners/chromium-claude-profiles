# Troubleshooting

Start with `ccp doctor`. It checks Node, the native messaging host and whether the extension is answering, and prints the one thing to do next.

## The popup's Agents line shows an error, or `ccp` says it cannot reach the browser

`ccp` talks to the extension through a native messaging host. Run:

```sh
ccp install-host --chromium-default
```

Then press **Reload extension** in the popup (or reload it in `chrome://extensions`) and check the Agents line again. It should show "Launcher answered in N ms". If Chromium was closed, `ccp launch` starts it for you and waits up to 20 seconds for the extension to connect.

## I pulled new code but nothing changed

Chromium keeps serving an unpacked extension's old service worker across restarts and version bumps. Press **Reload extension** in the popup after every `git pull`. The popup page itself always loads fresh from disk, so the popup can look new while the background code is old.

## A switch fails and leaves me on the previous account

A saved account whose session has been revoked cannot be switched to. The extension rolls the cookies back so you stay where you were. This almost always means the account was logged out in claude.ai. The account will show **Signed out**: switch to the browser's current account, use **Sign in another account**, sign in to the broken one and press **Save current** with the same label.

## An account shows "Signed out" but I did not log out

Sessions can expire or be revoked by Anthropic (a password change, for example). **Expires soon** warns three days before the session cookie's expiry. Sign in again and save.

## "Couldn't check"

The extension could not reach claude.ai (offline, or Cloudflare challenged the request). It retries hourly. Press the popup open again to re-check.

## My claude.ai tab lost what I was typing

Switching reloads every claude.ai tab. Finish or copy your message first.

## `ccp open-for` closed its tab and said no account can see the link

None of the saved accounts could open that link: it may belong to an account you have not saved, or the page text did not match what the checker expects. The check is a heuristic over the page's text (it looks for "couldn't be found" and for redirects to sign-in), and waits about 8 seconds after load. Open the link by switching to the right account yourself.

## "Sign back in" does nothing or stops early

It needs Claude in Chrome signed in in this browser, a Claude Code config directory signed in to the same account, and a mailbox entry for the account in `relogin.json`. Check the latest file in `~/.config/chromium-claude-profiles/logs/`. It never solves a CAPTCHA; if it hits one it stops and you finish by hand.

## Two accounts needed at once

Not possible in one browser, because Chromium shares one cookie store. Use a second browser, or switch between them.

## Migration says a profile "runs an old service worker"

Open that old profile once, press **Reload extension**, and run `ccp migrate` again.

## Still stuck

Run `ccp status --json` and `ccp list --json` and open an issue with the output. Those never include cookie values, but check for email addresses before posting.
