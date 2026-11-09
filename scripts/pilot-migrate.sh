#!/bin/bash
# Move Aaron's Mac onto the one-Chromium model, safely and repeatably.
# Reads before it writes, prints every step, and with --dry-run changes nothing.
# Never uses sudo, never touches anything outside $HOME, never quits the main
# Chromium, never logs an account out, never deletes a profile folder and never
# prints a cookie or token. See scripts/README.md.
set -euo pipefail

usage() {
	cat <<'EOF'
usage: scripts/pilot-migrate.sh [--dry-run]

  1. fast-forwards the ccp checkout to origin/main and links ~/.local/bin/ccp to it
  2. installs ccp's native messaging host for the main Chromium (ccp install-host --chromium-default)
  3. checks the Claude Profiles extension is loaded in the main Chromium and connected to ccp
  4. runs ccp migrate, saving each old profile's live Claude session into the main Chromium
  5. quits the old per-account profile browsers ccp started, never the main Chromium
  6. prints every account's state and which need one sign-in

Exit 0 when done, 3 when it stopped for a hand step it printed, 1 on an error.
EOF
}

DRY=0
for arg in "$@"; do
	case $arg in
		--dry-run | -n) DRY=1 ;;
		--help | -h) usage; exit 0 ;;
		*) usage >&2; exit 2 ;;
	esac
done

REPO=${CCP_REPO:-$HOME/workspace/chromium-claude-profiles}
CCP_HOME=${CCP_HOME:-$HOME/.config/chromium-claude-profiles}
CHROMIUM_DIR=${CCP_CHROMIUM_SUPPORT:-$HOME/Library/Application Support/Chromium}
BIN_LINK=${CCP_BIN_LINK:-$HOME/.local/bin/ccp}
REMOTE_URL=${CCP_REMOTE:-git@github.com:kranners/chromium-claude-profiles.git}
EXT_ID=bkgjdpakjigjgdggfcckikppbjjcdkim
NODE=${CCP_NODE:-$(cat "$CCP_HOME/node" 2>/dev/null || command -v node || true)}
BRIDGE_WAIT=${CCP_BRIDGE_WAIT:-90}
export CCP_HOME

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
plan() { if [ "$DRY" = 1 ]; then say "would: $*"; else say "doing: $*"; fi; }
die() { printf 'pilot-migrate: %s\n' "$*" >&2; exit 1; }
stop_for_hand() {
	printf '\nSTOPPED, nothing quit or migrated yet. %s\nThen run this again.\n' "$*"
	exit 3
}

[ "$(id -u)" != 0 ] || [ "${CCP_MIGRATE_TEST:-}" = 1 ] || die "run this as yourself, not root"
[ "$DRY" = 1 ] && say "Dry run: reading only, changing nothing."

ccp() { "$REPO/launcher/bin/ccp" "$@"; }

# json <expression over `j`> reads JSON on stdin and prints the expression's lines.
json() {
	"$NODE" -e '
		let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
			let j; try { j = JSON.parse(s); } catch { j = null; }
			const out = (function () { return eval(process.argv[1]); })();
			if (out !== undefined && out !== null) process.stdout.write(String(out) + (String(out).length ? "\n" : ""));
		});' "$1"
}

# ---------------------------------------------------------------------------
step "1. ccp checkout ($REPO)"
[ -x "$NODE" ] || die "no Node at $NODE; set CCP_NODE to a Node 24"

if [ ! -d "$REPO/.git" ]; then
	[ ! -e "$REPO" ] || die "$REPO exists but is not a git checkout; move it aside first"
	plan "git clone $REMOTE_URL $REPO"
	if [ "$DRY" = 0 ]; then
		mkdir -p "$(dirname "$REPO")"
		git clone --quiet "$REMOTE_URL" "$REPO"
	fi
else
	branch=$(git -C "$REPO" symbolic-ref --quiet --short HEAD || echo "(detached)")
	[ "$branch" = main ] || die "the checkout is on $branch, not main; switch it to main yourself first"
	if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
		die "the checkout has local changes; commit or stash them first (git -C $REPO status)"
	fi
	head=$(git -C "$REPO" rev-parse HEAD)
	if [ "$DRY" = 1 ]; then
		remote=$(git -C "$REPO" ls-remote origin refs/heads/main | cut -f1)
		[ -n "$remote" ] || die "could not read origin's main"
	else
		git -C "$REPO" fetch --quiet origin main
		remote=$(git -C "$REPO" rev-parse FETCH_HEAD)
	fi
	if [ "$head" = "$remote" ]; then
		say "already at origin/main (${head:0:7})"
	else
		plan "fast-forward main ${head:0:7} -> ${remote:0:7}"
		if [ "$DRY" = 0 ]; then
			git -C "$REPO" merge --quiet --ff-only "$remote" ||
				die "main has commits origin/main lacks, so it cannot fast-forward; sort that out by hand"
		fi
	fi
fi

# ---------------------------------------------------------------------------
step "2. ccp on the PATH ($BIN_LINK)"
want="$REPO/launcher/bin/ccp"
if [ -L "$BIN_LINK" ] && [ "$(readlink "$BIN_LINK")" = "$want" ]; then
	say "already links to $want"
elif [ -e "$BIN_LINK" ] || [ -L "$BIN_LINK" ]; then
	say "left alone: $BIN_LINK is something else ($(readlink "$BIN_LINK" 2>/dev/null || echo 'a file')); this script uses $want directly"
else
	plan "ln -s $want $BIN_LINK"
	[ "$DRY" = 1 ] || { mkdir -p "$(dirname "$BIN_LINK")"; ln -s "$want" "$BIN_LINK"; }
fi

if [ "$DRY" = 1 ] && [ ! -x "$want" ]; then
	say "(dry run: ccp is not checked out yet, so the rest is what a real run checks)"
	exit 0
fi

# ---------------------------------------------------------------------------
step "3. native messaging host for the main Chromium"
manifest="$CHROMIUM_DIR/NativeMessagingHosts/engineer.cute.claude_profiles.json"
plan "ccp install-host --chromium-default (rewrites ccp's own host manifests; safe to repeat)"
if [ "$DRY" = 0 ]; then
	ccp install-host --chromium-default | sed 's/^/  /'
elif [ -e "$manifest" ]; then
	say "a manifest is already at $manifest"
fi

# ---------------------------------------------------------------------------
step "4. Claude Profiles in the main Chromium"
loaded_in=""
for prefs in "$CHROMIUM_DIR"/Default/Secure\ Preferences "$CHROMIUM_DIR"/Default/Preferences \
	"$CHROMIUM_DIR"/Profile\ */Secure\ Preferences "$CHROMIUM_DIR"/Profile\ */Preferences; do
	[ -f "$prefs" ] || continue
	if grep -q "$EXT_ID" "$prefs" 2>/dev/null; then
		loaded_in=$(basename "$(dirname "$prefs")")
		break
	fi
done

main_pid=""
lock=$(readlink "$CHROMIUM_DIR/SingletonLock" 2>/dev/null || true)
if [ -n "$lock" ]; then
	pid=${lock##*-}
	if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then main_pid=$pid; fi
fi
if [ -n "$main_pid" ]; then say "main Chromium is running (pid $main_pid); it is never quit"; else say "main Chromium is not running"; fi

connected() { ccp list --json 2>/dev/null | json 'j && j.browser && j.browser.connected ? "yes" : "no"'; }

if [ -z "$loaded_in" ]; then
	say "Claude Profiles is not loaded in the main Chromium yet."
	[ "$DRY" = 1 ] && { say "would stop here and ask for the one hand step below"; }
	stop_for_hand "One hand step: in your main Chromium open chrome://extensions, turn on Developer mode, choose Load unpacked and pick $REPO/extension. Then open its popup and save the account you are signed in to."
fi
say "Claude Profiles is loaded in the main Chromium ($loaded_in)"

state=$(connected)
if [ "$state" != yes ] && [ -n "$main_pid" ] && [ "$DRY" = 0 ]; then
	say "waiting up to ${BRIDGE_WAIT}s for the extension to connect to ccp (it retries every minute)"
	waited=0
	while [ "$waited" -lt "$BRIDGE_WAIT" ] && [ "$state" != yes ]; do
		sleep 5
		waited=$((waited + 5))
		state=$(connected)
	done
fi
if [ "$state" = yes ]; then
	say "the extension answers ccp"
elif [ -n "$main_pid" ]; then
	[ "$DRY" = 1 ] && say "would wait up to ${BRIDGE_WAIT}s for it to connect"
	[ "$DRY" = 1 ] || stop_for_hand "The extension is loaded but not answering ccp, so it still runs its old code: open the Claude Profiles popup and press Reload extension."
else
	say "ccp migrate will start the main Chromium plain and wait for the extension"
fi

# ---------------------------------------------------------------------------
step "5. old per-account profiles ($CCP_HOME/profiles)"
profile_pid() { # pid of the browser ccp started on that profile folder, or nothing
	local dir=$1 target pid args
	target=$(readlink "$dir/SingletonLock" 2>/dev/null) || return 0
	pid=${target##*-}
	case $pid in '' | *[!0-9]*) return 0 ;; esac
	kill -0 "$pid" 2>/dev/null || return 0
	args=$(ps -ww -o args= -p "$pid" 2>/dev/null) || return 0
	case "$args " in *"--user-data-dir=$dir "*) printf '%s\n' "$pid" ;; esac
}

profiles=()
if [ -d "$CCP_HOME/profiles" ]; then
	for dir in "$CCP_HOME"/profiles/*/; do
		[ -d "$dir" ] || continue
		dir=${dir%/}
		profiles+=("$dir")
		pid=$(profile_pid "$dir")
		say "$(basename "$dir"): ${pid:+running as pid $pid}${pid:-not running}"
	done
fi
[ "${#profiles[@]}" -gt 0 ] || say "none"

migration=""
if [ -f "$CCP_HOME/profiles.json" ]; then
	plan "ccp migrate (reads each old profile's live session through its own extension and saves it in the main Chromium; cookies are never printed)"
	if [ "$DRY" = 0 ]; then
		migration=$(ccp migrate --json) || {
			say "$(printf '%s' "$migration" | json 'j && j.error ? j.error.message : "ccp migrate failed"')"
			die "ccp migrate failed; nothing was quit"
		}
		printf '%s' "$migration" | json '(j.profiles || []).map((r) => "  " + r.profile + " (" + (r.email || "no email") + "): " + r.outcome + (r.reason ? " - " + r.reason : "")).join("\n")'
	fi
else
	say "no profiles.json, so nothing to migrate"
fi

# ---------------------------------------------------------------------------
step "6. quit the old profile browsers"
running() { kill -0 "$1" 2>/dev/null && [ "$(ps -o stat= -p "$1" 2>/dev/null | cut -c1)" != Z ]; }
quit_any=0
for dir in "${profiles[@]+"${profiles[@]}"}"; do
	name=$(basename "$dir")
	pid=$(profile_pid "$dir")
	[ -n "$pid" ] || continue
	[ "$pid" != "$main_pid" ] || continue
	if [ -n "$migration" ]; then
		outcome=$(printf '%s' "$migration" | NAME=$name json '((j.profiles || []).find((r) => r.profile === process.env.NAME) || {}).outcome || ""')
		if [ "$outcome" = unreachable ]; then
			say "$name: kept running, since its session could not be read yet; see its reason above"
			continue
		fi
	fi
	quit_any=1
	plan "quit $name's browser (pid $pid), leaving its folder in place"
	[ "$DRY" = 1 ] && continue
	kill -TERM "$pid" 2>/dev/null || true
	for _ in $(seq 1 50); do running "$pid" || break; sleep 0.2; done
	if running "$pid"; then say "  $name is still closing; it will finish on its own"; else say "  $name closed"; fi
done
[ "$quit_any" = 1 ] || say "no old profile browser to quit"

agents=$(grep -l -s -e 'chromium-claude-profiles/profiles' -e 'ccp launch' "$HOME"/Library/LaunchAgents/*.plist 2>/dev/null || true)
if [ -n "$agents" ]; then
	say "These login items still mention the old profiles; left alone, check them yourself:"
	printf '%s\n' "$agents" | sed 's/^/  /'
fi

# ---------------------------------------------------------------------------
step "7. accounts"
if [ "$DRY" = 1 ]; then
	plan "ccp status (checks every saved session in the main Chromium)"
	ccp list 2>/dev/null | sed 's/^/  /' || true
	exit 0
fi
ccp status | sed 's/^/  /' || true
need=$(ccp list --json 2>/dev/null | json '(j && j.accounts || []).filter((a) => a.state === "signed-out").map((a) => a.email || a.label).join(", ")')
if [ -n "$need" ]; then
	say ""
	say "Needs one sign-in in the main Chromium: $need"
	say "(Claude Profiles popup: Sign back in to signed-out accounts, or sign in and press Save current. Never log a saved account out.)"
else
	say ""
	say "Every saved account is signed in."
fi
say "Old profile folders are left in $CCP_HOME/profiles; delete them yourself once you are happy."
