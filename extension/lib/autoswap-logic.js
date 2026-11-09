// Pure decisions for auto-swap: which links we handle, which account to try in which order,
// and the settings shape. Nothing here touches chrome.* so it is unit tested directly.

export const SETTINGS_KEY = "autoswap";
export const SUPPRESS_AFTER_SWITCH_MS = 20_000;
export const TAB_COOLDOWN_MS = 60_000;
export const UNRESOLVED_MS = 10 * 60_000;
export const MAX_CACHE_ENTRIES = 500;
// claude.ai sends a chat it cannot show to /new with a toast; a redirect this soon after the link loaded counts.
export const REDIRECT_WINDOW_MS = 8_000;

// claude.ai paths whose second segment is an id of something one account owns.
const RESOURCE_ROOTS = new Set(["chat", "chats", "code", "project", "projects", "artifacts", "share", "task", "tasks"]);

// The same link in a different shape (query, hash, trailing path) is the same resource.
export const linkKey = (url) => {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" || parsed.hostname !== "claude.ai") return null;
	const [root, id] = parsed.pathname.split("/").filter(Boolean);
	if (!root || !id || !RESOURCE_ROOTS.has(root.toLowerCase())) return null;
	return `${root.toLowerCase()}/${id}`;
};

export const defaultSettings = () => ({
	enabled: true,
	confirmed: false,
	optOut: [],
	cache: {},
	pending: null,
	last: null,
});

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export const normalizeSettings = (raw) => {
	const base = defaultSettings();
	if (!isPlainObject(raw)) return base;
	return {
		enabled: raw.enabled !== false,
		confirmed: raw.confirmed === true,
		optOut: Array.isArray(raw.optOut) ? raw.optOut.filter((key) => typeof key === "string") : [],
		cache: isPlainObject(raw.cache)
			? Object.fromEntries(Object.entries(raw.cache).filter(([, label]) => typeof label === "string"))
			: {},
		pending: isPlainObject(raw.pending) && typeof raw.pending.url === "string" ? raw.pending : null,
		last: isPlainObject(raw.last) ? raw.last : null,
	};
};

export const withOptOut = (settings, key, optedOut) => ({
	...settings,
	optOut: optedOut ? [...new Set([...settings.optOut, key])] : settings.optOut.filter((entry) => entry !== key),
});

// Newest entries last; the oldest fall off past the cap.
export const withOwner = (settings, key, label) => {
	const { [key]: _old, ...rest } = settings.cache;
	const entries = Object.entries({ ...rest, [key]: label });
	return { ...settings, cache: Object.fromEntries(entries.slice(-MAX_CACHE_ENTRIES)) };
};

export const withoutOwner = (settings, key) => {
	const { [key]: _old, ...rest } = settings.cache;
	return { ...settings, cache: rest };
};

// Why we should leave this navigation alone, or null to go ahead.
export const skipReason = ({ settings, key, tabId, now, lastSwitchMs, handled, unresolved }) => {
	if (key === null) return "not-a-resource-link";
	if (!settings.enabled) return "disabled";
	if (settings.optOut.includes(key)) return "link-opted-out";
	if (lastSwitchMs < SUPPRESS_AFTER_SWITCH_MS) return "recent-switch";
	const seen = handled.get(tabId);
	if (seen && seen.key === key && now - seen.at < TAB_COOLDOWN_MS) return "tab-cooldown";
	const failedAt = unresolved.get(key);
	if (failedAt !== undefined && now - failedAt < UNRESOLVED_MS) return "recently-unresolved";
	return null;
};

// Stricter than open-for's heuristic: a stray "not found" in a chat must not read as a missing page.
const MISSING =
	/couldn[’']?t be found|could not be found|no longer available|(session|conversation|chat|project|artifact|page) (was )?not found|does(n[’']?t| not) exist|(don[’']?t|do not) have access to (this|that)/i;

export const isMissingText = (text) => MISSING.test((text ?? "").slice(0, 1500));

// True when a tab that just loaded a resource link is now somewhere else on claude.ai.
export const redirectedAway = ({ pending, now, url }) =>
	pending !== undefined &&
	now - pending.at < REDIRECT_WINDOW_MS &&
	linkKey(url) === null &&
	(() => {
		try {
			return new URL(url).hostname === "claude.ai" && !/^\/(login|magic-link)\b/.test(new URL(url).pathname);
		} catch {
			return false;
		}
	})();

// `key` is the link being judged: landing somewhere else on claude.ai means the link was not available.
export const classifyLinkPage = ({ url, text, settled, key }) => {
	let path = "";
	try {
		path = new URL(url).pathname;
	} catch {
		return null;
	}
	if (/^\/(login|magic-link)\b/.test(path)) return "signed-out";
	if (isMissingText(text)) return "not-found";
	if (key !== undefined && linkKey(url) !== key) return "not-found";
	return settled ? "found" : null;
};

// Drives the search for the account that owns a link. All effects come in through deps:
//   verdict()       what the tab shows under the account active now: found | not-found | signed-out | closed
//   switchTo(label) make that account active; true on success
//   show()          put the original link back in the tab after a switch
export const resolveLink = async ({ cachedLabel, active, labels, deps, activeMissing = false }) => {
	const usable = [...new Set(labels)].sort();
	if (active === null) return { outcome: "skipped", reason: "active-account-not-saved", tried: [] };
	if (usable.length < 2) return { outcome: "skipped", reason: "single-account", tried: [] };
	if (cachedLabel === active) return { outcome: "stay", label: active, tried: [] };

	const order = [...new Set([...(cachedLabel && usable.includes(cachedLabel) ? [cachedLabel] : []), active, ...usable])];
	const tried = [];
	let current = active;

	const restore = async () => {
		if (current === active) return;
		if (await deps.switchTo(active)) current = active;
		await deps.show();
	};

	for (const label of order) {
		if (label !== current) {
			if (!(await deps.switchTo(label))) {
				tried.push({ label, result: "error" });
				continue;
			}
			current = label;
			await deps.show();
		}
		const assumed = activeMissing && label === active && tried.length === 0;
		const result = assumed ? "not-found" : await deps.verdict();
		tried.push({ label, result });
		if (result === "found") return { outcome: label === active ? "stay" : "swapped", label, tried };
		if (result === "closed") {
			await restore();
			return { outcome: "closed", tried };
		}
	}
	await restore();
	return { outcome: "unresolved", tried };
};
