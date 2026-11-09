import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
	MAX_CACHE_ENTRIES,
	REDIRECT_WINDOW_MS,
	isMissingText,
	redirectedAway,
	SUPPRESS_AFTER_SWITCH_MS,
	TAB_COOLDOWN_MS,
	UNRESOLVED_MS,
	classifyLinkPage,
	defaultSettings,
	linkKey,
	normalizeSettings,
	resolveLink,
	skipReason,
	withOptOut,
	withOwner,
	withoutOwner,
} from "../lib/autoswap-logic.js";
import { CONTENT_TYPES, EXTERNAL_TYPES, POPUP_TYPES } from "../lib/protocol.js";

test("linkKey names the resource and ignores query, hash and deeper paths", () => {
	assert.equal(linkKey("https://claude.ai/code/cshk_01ABC?x=1#y"), "code/cshk_01ABC");
	assert.equal(linkKey("https://claude.ai/chat/1234-abcd/"), "chat/1234-abcd");
	assert.equal(linkKey("https://claude.ai/CHAT/Id9/extra/path"), "chat/Id9");
	assert.equal(linkKey("https://claude.ai/project/p1"), "project/p1");
	assert.equal(linkKey("https://claude.ai/artifacts/a1"), "artifacts/a1");
	assert.equal(linkKey("https://claude.ai/share/s1"), "share/s1");
});

test("linkKey rejects pages that are not one account's resource", () => {
	for (const url of [
		"https://claude.ai/",
		"https://claude.ai/new",
		"https://claude.ai/login",
		"https://claude.ai/code",
		"https://claude.ai/settings/profile",
		"https://claude.ai/recents",
		"http://claude.ai/chat/abc",
		"https://evil.example/chat/abc",
		"https://claude.ai.evil.example/chat/abc",
		"https://docs.claude.ai/chat/abc",
		"not a url",
		undefined,
	]) {
		assert.equal(linkKey(url), null, String(url));
	}
});

test("normalizeSettings repairs anything stored badly and defaults to on, unconfirmed", () => {
	assert.deepEqual(normalizeSettings(undefined), defaultSettings());
	assert.equal(defaultSettings().enabled, true);
	assert.equal(defaultSettings().confirmed, false);
	const fixed = normalizeSettings({ enabled: false, confirmed: "yes", optOut: ["a", 3], cache: { a: "x", b: 4 }, pending: {}, last: [] });
	assert.deepEqual(fixed, { enabled: false, confirmed: false, optOut: ["a"], cache: { a: "x" }, pending: null, last: null });
});

test("opt-outs add once and remove", () => {
	let s = withOptOut(defaultSettings(), "chat/a", true);
	s = withOptOut(s, "chat/a", true);
	assert.deepEqual(s.optOut, ["chat/a"]);
	assert.deepEqual(withOptOut(s, "chat/a", false).optOut, []);
});

test("the owner cache keeps the newest entries and can forget one", () => {
	let s = defaultSettings();
	for (let i = 0; i < MAX_CACHE_ENTRIES + 5; i++) s = withOwner(s, `chat/${i}`, "a");
	assert.equal(Object.keys(s.cache).length, MAX_CACHE_ENTRIES);
	assert.equal("chat/0" in s.cache, false);
	assert.equal(withoutOwner(withOwner(defaultSettings(), "chat/z", "a"), "chat/z").cache["chat/z"], undefined);
});

const base = () => ({
	settings: { ...defaultSettings(), confirmed: true },
	key: "chat/a",
	tabId: 1,
	now: 1_000_000,
	lastSwitchMs: 10 * SUPPRESS_AFTER_SWITCH_MS,
	handled: new Map(),
	unresolved: new Map(),
});

test("skipReason lets an ordinary navigation through", () => {
	assert.equal(skipReason(base()), null);
});

test("skipReason refuses: no link, disabled, opted out, right after a switch", () => {
	assert.equal(skipReason({ ...base(), key: null }), "not-a-resource-link");
	assert.equal(skipReason({ ...base(), settings: { ...base().settings, enabled: false } }), "disabled");
	assert.equal(skipReason({ ...base(), settings: withOptOut(base().settings, "chat/a", true) }), "link-opted-out");
	assert.equal(skipReason({ ...base(), lastSwitchMs: SUPPRESS_AFTER_SWITCH_MS - 1 }), "recent-switch");
});

test("a tab is left alone for a minute after we handled the same link, but not a different one", () => {
	const handled = new Map([[1, { key: "chat/a", at: 1_000_000 - TAB_COOLDOWN_MS + 1 }]]);
	assert.equal(skipReason({ ...base(), handled }), "tab-cooldown");
	assert.equal(skipReason({ ...base(), handled, key: "chat/b" }), null);
	assert.equal(skipReason({ ...base(), handled: new Map([[1, { key: "chat/a", at: 1_000_000 - TAB_COOLDOWN_MS }]]) }), null);
});

test("a link no account could see is not retried for ten minutes", () => {
	const unresolved = new Map([["chat/a", 1_000_000 - UNRESOLVED_MS + 1]]);
	assert.equal(skipReason({ ...base(), unresolved }), "recently-unresolved");
	assert.equal(skipReason({ ...base(), unresolved: new Map([["chat/a", 1_000_000 - UNRESOLVED_MS]]) }), null);
});

test("classifyLinkPage tells missing pages from real ones and does not trip on prose", () => {
	const url = "https://claude.ai/code/x";
	assert.equal(classifyLinkPage({ url, text: "Session couldn't be found", settled: false }), "not-found");
	assert.equal(classifyLinkPage({ url, text: "This conversation does not exist", settled: false }), "not-found");
	assert.equal(classifyLinkPage({ url: "https://claude.ai/login?next=%2Fchat", text: "", settled: false }), "signed-out");
	assert.equal(classifyLinkPage({ url, text: "Fix the build", settled: false }), null);
	assert.equal(classifyLinkPage({ url, text: "Fix the build", settled: true }), "found");
	assert.equal(classifyLinkPage({ url, text: "ENOENT: file was not found in the cache", settled: true }), "found");
	assert.equal(classifyLinkPage({ url: "bad", text: "", settled: true }), null);
});

const fakeDeps = ({ owner, signedOut = [], failSwitch = [], closedOn = null }) => {
	const state = { current: null, switches: [], shows: 0 };
	return {
		state,
		deps: {
			verdict: async () => (state.current === closedOn ? "closed" : state.current === owner ? "found" : signedOut.includes(state.current) ? "signed-out" : "not-found"),
			switchTo: async (label) => {
				state.switches.push(label);
				if (failSwitch.includes(label)) return false;
				state.current = label;
				return true;
			},
			show: async () => {
				state.shows++;
			},
		},
	};
};

const run = async ({ active, labels, cachedLabel = null, ...rest }) => {
	const fake = fakeDeps(rest);
	fake.state.current = active;
	const result = await resolveLink({ cachedLabel, active, labels, deps: fake.deps });
	return { result, ...fake.state };
};

test("the active account owning the link means no switch, and the owner is learned", async () => {
	const { result, switches } = await run({ active: "a", labels: ["a", "b", "c"], owner: "a" });
	assert.equal(result.outcome, "stay");
	assert.equal(result.label, "a");
	assert.deepEqual(switches, []);
});

test("another account owning the link is found by trying the rest in order and kept active", async () => {
	const { result, switches, current } = await run({ active: "a", labels: ["a", "b", "c"], owner: "c" });
	assert.equal(result.outcome, "swapped");
	assert.equal(result.label, "c");
	assert.deepEqual(switches, ["b", "c"]);
	assert.equal(current, "c");
	assert.deepEqual(result.tried.map((t) => t.result), ["not-found", "not-found", "found"]);
});

test("a remembered owner is tried before anything else", async () => {
	const { result, switches } = await run({ active: "a", labels: ["a", "b", "c"], owner: "c", cachedLabel: "c" });
	assert.equal(result.outcome, "swapped");
	assert.deepEqual(switches, ["c"]);
});

test("a remembered owner that is already active is trusted without loading the page again", async () => {
	const { result, switches } = await run({ active: "b", labels: ["a", "b"], owner: "a", cachedLabel: "b" });
	assert.equal(result.outcome, "stay");
	assert.deepEqual(switches, []);
});

test("a stale remembered owner falls back to searching and ends on the true owner", async () => {
	const { result, switches } = await run({ active: "a", labels: ["a", "b", "c"], owner: "b", cachedLabel: "c" });
	assert.equal(result.outcome, "swapped");
	assert.equal(result.label, "b");
	assert.deepEqual(switches, ["c", "a", "b"]);
});

test("a link nobody can see puts the original account back", async () => {
	const { result, switches, current } = await run({ active: "a", labels: ["a", "b", "c"], owner: "nobody" });
	assert.equal(result.outcome, "unresolved");
	assert.equal(current, "a");
	assert.deepEqual(switches, ["b", "c", "a"]);
});

test("an account that cannot be switched to is skipped, not fatal", async () => {
	const { result } = await run({ active: "a", labels: ["a", "b", "c"], owner: "c", failSwitch: ["b"] });
	assert.equal(result.outcome, "swapped");
	assert.equal(result.tried[1].result, "error");
});

test("a closed tab stops the search and restores the account", async () => {
	const { result, current } = await run({ active: "a", labels: ["a", "b", "c"], owner: "c", closedOn: "b" });
	assert.equal(result.outcome, "closed");
	assert.equal(current, "a");
});

test("nothing happens with one account, or when the active login is not a saved account", async () => {
	assert.equal((await run({ active: "a", labels: ["a"], owner: "x" })).result.reason, "single-account");
	const unsaved = await run({ active: null, labels: ["a", "b"], owner: "x" });
	assert.equal(unsaved.result.reason, "active-account-not-saved");
	assert.deepEqual(unsaved.switches, []);
});

test("the confirmation banner can only turn auto-swap on or off, and the popup alone can read or edit it", () => {
	assert.deepEqual([...CONTENT_TYPES], ["autoswap.setEnabled"]);
	for (const type of ["autoswap.get", "autoswap.setEnabled", "autoswap.setLinkOptOut", "autoswap.forgetLink", "autoswap.clearCache"]) {
		assert.equal(POPUP_TYPES.has(type), true, type);
		assert.equal(EXTERNAL_TYPES.has(type), false, type);
	}
});

test("the manifest still asks only for what auto-swap needs", async () => {
	const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
	assert.deepEqual(manifest.host_permissions, ["https://claude.ai/*", "https://*.claude.ai/*"]);
	assert.equal(manifest.permissions.includes("tabs"), false);
});

test("only claude.ai pages may message the extension from outside", async () => {
	const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
	assert.deepEqual(manifest.externally_connectable.matches, ["https://claude.ai/*", "https://*.claude.ai/*"]);
});

test("a link claude.ai sends away to /new counts as missing, a click elsewhere later does not", () => {
	const pending = { key: "chat/a", url: "https://claude.ai/chat/a", at: 1_000 };
	assert.equal(redirectedAway({ pending, now: 2_000, url: "https://claude.ai/new" }), true);
	assert.equal(redirectedAway({ pending, now: 1_000 + REDIRECT_WINDOW_MS, url: "https://claude.ai/new" }), false);
	assert.equal(redirectedAway({ pending, now: 2_000, url: "https://claude.ai/chat/b" }), false);
	assert.equal(redirectedAway({ pending, now: 2_000, url: "https://claude.ai/login" }), false);
	assert.equal(redirectedAway({ pending, now: 2_000, url: "https://example.com/" }), false);
	assert.equal(redirectedAway({ pending: undefined, now: 2_000, url: "https://claude.ai/new" }), false);
});

test("the toast text and a redirect away from the link both read as not found", () => {
	assert.equal(isMissingText("That session is no longer available. Starting a new one."), true);
	assert.equal(isMissingText("New week, Aaron"), false);
	const base = { url: "https://claude.ai/new", text: "New week", settled: true };
	assert.equal(classifyLinkPage({ ...base, key: "chat/a" }), "not-found");
	assert.equal(classifyLinkPage({ ...base, url: "https://claude.ai/chat/a", key: "chat/a" }), "found");
	assert.equal(classifyLinkPage({ ...base, key: undefined }), "found");
});

test("when the active account is already known to miss the link, the others are tried straight away", async () => {
	const fake = fakeDeps({ owner: "b" });
	fake.state.current = "a";
	const result = await resolveLink({ cachedLabel: null, active: "a", labels: ["a", "b"], deps: fake.deps, activeMissing: true });
	assert.equal(result.outcome, "swapped");
	assert.equal(result.label, "b");
	assert.deepEqual(result.tried.map((t) => t.result), ["not-found", "found"]);
	assert.deepEqual(fake.state.switches, ["b"]);
});
