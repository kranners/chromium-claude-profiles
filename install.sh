#!/bin/sh
# Claude Profiles installer: macOS and Linux, no sudo, safe to run again.
#
#   curl -fsSL https://raw.githubusercontent.com/kranners/chromium-claude-profiles/main/install.sh | sh
#   ./install.sh [--browser chromium|chrome|brave] [--dry-run] [--help]
#
# It (1) finds Node 24 or newer, (2) clones or fast-forwards the repository, (3) links `ccp` into
# ~/.local/bin, (4) installs the native messaging host for your browser, and (5) runs `ccp doctor`.
# It touches only your home directory. It never edits shell startup files, never installs software
# and never signs anyone in or out. The one step it cannot do for you is loading the extension.
#
# Exit codes: 0 ready, 3 waiting on you to load the extension (steps printed), 4 a prerequisite is
# missing (what to install is printed), 1 any other error.
set -eu

REPO_URL=${CCP_REPO_URL:-https://github.com/kranners/chromium-claude-profiles.git}
BIN_DIR=${CCP_BIN_DIR:-$HOME/.local/bin}
BROWSER=${CCP_BROWSER:-}
DIR=${CCP_DIR:-}
DRY=0

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
need() { printf 'install.sh: %s\n' "$*" >&2; exit 4; }
do_it() { if [ "$DRY" = 1 ]; then say "would: $*"; else "$@"; fi; }

while [ $# -gt 0 ]; do
	case $1 in
		--browser) [ $# -ge 2 ] || die "--browser needs chromium, chrome or brave"; BROWSER=$2; shift 2 ;;
		--dir) [ $# -ge 2 ] || die "--dir needs a folder"; DIR=$2; shift 2 ;;
		--dry-run) DRY=1; shift ;;
		-h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) die "unknown option: $1" ;;
	esac
done

case $BROWSER in ""|chromium|chrome|brave) ;; *) die "--browser must be chromium, chrome or brave" ;; esac
[ "$(id -u)" != 0 ] || die "run this as yourself, not root"
[ "$DRY" = 1 ] && say "Dry run: looking only, changing nothing."

case $(uname -s) in
	Darwin) OS=darwin ;;
	Linux) OS=linux ;;
	*) need "only macOS and Linux are supported (this is $(uname -s))" ;;
esac

# --- Node 24 or newer -------------------------------------------------------------------------
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

find_node() {
	for candidate in "${CCP_NODE:-}" "$(command -v node 2>/dev/null || true)" \
		/opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node" \
		"$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
		"$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node; do
		[ -n "$candidate" ] && [ -x "$candidate" ] || continue
		if [ "$(node_major "$candidate")" -ge 24 ]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done
	return 1
}

step "Node"
NODE=$(find_node) || need "Node 24 or newer is required and was not found.
  macOS: brew install node     Linux: install Node 24+ (https://nodejs.org or fnm), then run this again."
say "using $NODE (v$("$NODE" -p process.versions.node))"

command -v git >/dev/null 2>&1 || need "git is required (macOS: xcode-select --install)."

# --- the checkout -----------------------------------------------------------------------------
step "Checkout"
SELF_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P || true)
if [ -z "$DIR" ] && [ -n "$SELF_DIR" ] && [ -x "$SELF_DIR/launcher/bin/ccp" ] && [ -d "$SELF_DIR/extension" ]; then
	DIR=$SELF_DIR
	say "running from the checkout at $DIR"
else
	DIR=${DIR:-$HOME/.local/share/chromium-claude-profiles}
	if [ -d "$DIR/.git" ]; then
		if [ -n "$(git -C "$DIR" status --porcelain 2>/dev/null)" ]; then
			say "$DIR has local changes; leaving it as it is"
		elif [ "$(git -C "$DIR" rev-parse --abbrev-ref HEAD)" != main ]; then
			say "$DIR is not on main; leaving it as it is"
		else
			do_it git -C "$DIR" pull --ff-only --quiet
			say "up to date: $DIR"
		fi
	elif [ -e "$DIR" ]; then
		die "$DIR exists and is not a checkout; move it or pass --dir"
	else
		do_it mkdir -p "$(dirname "$DIR")"
		do_it git clone --quiet "$REPO_URL" "$DIR"
		say "cloned into $DIR"
	fi
fi
CCP="$DIR/launcher/bin/ccp"
[ "$DRY" = 1 ] && [ ! -x "$CCP" ] && { say "(dry run stops here: nothing is cloned yet)"; exit 0; }
[ -x "$CCP" ] || die "$CCP is missing; is $DIR a Claude Profiles checkout?"

# --- ccp on PATH ------------------------------------------------------------------------------
step "ccp command"
LINK=$BIN_DIR/ccp
if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$CCP" ]; then
	say "$LINK already points here"
elif [ -e "$LINK" ] || [ -L "$LINK" ]; then
	say "$LINK already exists and is something else; leaving it. Use $CCP instead."
else
	do_it mkdir -p "$BIN_DIR"
	do_it ln -s "$CCP" "$LINK"
	say "linked $LINK"
fi
case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) say "note: $BIN_DIR is not on your PATH; add it to your shell startup file to type just 'ccp'." ;;
esac

# --- the browser ------------------------------------------------------------------------------
step "Browser"
if [ -z "$BROWSER" ]; then
	if [ "$OS" = darwin ]; then
		[ -d /Applications/Chromium.app ] && BROWSER=chromium
		[ -z "$BROWSER" ] && [ -d "/Applications/Google Chrome.app" ] && BROWSER=chrome
		[ -z "$BROWSER" ] && [ -d "/Applications/Brave Browser.app" ] && BROWSER=brave
	else
		for pair in chromium:chromium chromium:chromium-browser chrome:google-chrome-stable chrome:google-chrome brave:brave-browser; do
			if [ -z "$BROWSER" ] && command -v "${pair#*:}" >/dev/null 2>&1; then BROWSER=${pair%%:*}; fi
		done
	fi
	[ -n "$BROWSER" ] || need "no Chromium, Google Chrome or Brave found. Install one, or pass --browser."
fi
case $BROWSER in chromium|chrome|brave) ;; *) die "--browser must be chromium, chrome or brave" ;; esac
say "using $BROWSER"

# --- native messaging host --------------------------------------------------------------------
step "Native messaging host"
if [ "$DRY" = 1 ]; then
	say "would: ccp install-host --browser $BROWSER"
else
	CCP_NODE=$NODE "$CCP" install-host --browser "$BROWSER"
fi

# --- the extension and a health check ---------------------------------------------------------
step "Extension"
EXT="$DIR/extension"
say "Load this folder as an unpacked extension in $BROWSER:"
say "  $EXT"
say "  1. Open chrome://extensions   2. Turn on Developer mode   3. Load unpacked, choose the folder above."
if [ "$DRY" != 1 ] && [ -t 1 ]; then
	for clip in pbcopy "xclip -selection clipboard" wl-copy; do
		if command -v "${clip%% *}" >/dev/null 2>&1; then
			printf '%s' "$EXT" | $clip 2>/dev/null && say "(the folder path is on your clipboard)"
			break
		fi
	done
fi

step "Check"
if [ "$DRY" = 1 ]; then
	say "would: ccp doctor"
	exit 0
fi
if CCP_NODE=$NODE "$CCP" doctor; then
	say ""
	say "Ready. Save each Claude account: sign in at claude.ai, then run: ccp save <label>"
	exit 0
fi
say ""
say "Not ready yet. Finish the extension step above, keep the browser open, then run: $CCP doctor"
exit 3
