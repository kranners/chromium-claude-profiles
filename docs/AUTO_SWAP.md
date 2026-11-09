# Auto-swap

Open a claude.ai link that belongs to a different saved account and Claude Profiles switches to that account, then reloads the tab.

## What counts as a link

A claude.ai address whose first path part is one of `chat`, `chats`, `code`, `project`, `projects`, `artifacts`, `share`, `task` or `tasks` and which has an id after it, for example `https://claude.ai/code/<id>`. Query strings, fragments and anything after the id are ignored, so `?foo=1` and `/chat/<id>/anything` are the same link. The home page, `/new`, settings, login and list pages are never touched. Private (incognito) windows are never touched.

## How it finds the owner

1. If the link is remembered and the remembered account is already active, nothing happens.
2. If it is remembered as another account, the extension switches to that account first.
3. Otherwise it looks at what the tab shows under the active account. A page that loads normally means the active account owns it, and that is remembered.
4. If the page says it "couldn't be found" or "does not exist", or sends you to sign in, it tries each other saved account that is not signed out, in alphabetical order, reloading the tab each time. The first account that can see the link is kept and remembered.
5. If no account can see it, the account you started on is put back and the extension leaves that link alone for ten minutes.

Remembered owners live in the extension's local storage (link kind and id mapped to your own account label), never anywhere else, up to 500 of them. A remembered owner that stops working is dropped and the search starts again.

## Staying out of loops

- Switching reloads every claude.ai tab. Those reloads are ignored for 20 seconds, so they cannot trigger another switch.
- A tab is not handled twice for the same link within a minute.
- While another account operation is running (a switch from the popup, an `open-for` from `ccp`, the hourly check) auto-swap waits and tries again shortly, then gives up.
- A switch you make yourself from the popup is never undone, because of the 20-second quiet period.
- It never switches away from the account you are signed in to if that account has not been saved, because that session would be lost.

## What it cannot do

- Only one claude.ai account is active in the browser at a time. A tab for account A and a tab for account B cannot both work: when one is switched to, the other reloads into the new account and will show "couldn't be found" until you switch back. This is a property of how the browser stores cookies, not something the extension can change.
- The "couldn't be found" check reads the page text for a handful of phrases. If claude.ai changes its wording, the extension treats a missing page as found and does nothing; press Forget remembered links if an owner goes stale.
- It only knows about accounts you saved. A link owned by an account you have not saved is reported as "no saved account could see" in the popup.

## Controls

In the Claude Profiles popup, under Auto-swap:

- a switch to turn it off and on for everything;
- "Never auto-swap for this link" for the link in your current tab;
- "Forget remembered links" to clear what it has learned.

The first time a link would trigger a switch, a small banner on the claude.ai page asks once whether to turn auto-swap on. Nothing is switched before you answer. Choosing Not now turns it off.

Tabs opened by `ccp open-for` or `ccp launch` are handled by those commands and are not changed behind their back, because auto-swap waits while they run.
