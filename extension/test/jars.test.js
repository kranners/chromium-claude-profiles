import test from "node:test";
import assert from "node:assert/strict";
import { forgetAccount, isInfraCookie, summarizeJars, switchAccount, toSavedCookie, toSetDetails } from "../lib/jars.js";
import { EXTERNAL_TYPES, POPUP_TYPES, isLabel } from "../lib/protocol.js";

const chromeCookie = (overrides = {}) => ({
	name: "sessionKey",
	value: "fixture",
	domain: ".claude.ai",
	path: "/",
	secure: true,
	httpOnly: true,
	sameSite: "lax",
	expirationDate: 1893456000,
	hostOnly: false,
	session: false,
	storeId: "0",
	...overrides,
});

test("isInfraCookie flags only the Cloudflare cookies", () => {
	for (const name of ["__cf_bm", "cf_clearance", "_cfuvid", "__cflb"]) assert.equal(isInfraCookie(name), true);
	for (const name of ["sessionKey", "lastActiveOrg", "cf_bm"]) assert.equal(isInfraCookie(name), false);
});

test("toSavedCookie keeps only the stored fields", () => {
	assert.deepEqual(toSavedCookie(chromeCookie()), {
		name: "sessionKey",
		value: "fixture",
		domain: ".claude.ai",
		path: "/",
		secure: true,
		httpOnly: true,
		sameSite: "lax",
		expirationDate: 1893456000,
		hostOnly: false,
	});
});

test("toSavedCookie leaves expirationDate out for session cookies", () => {
	const { expirationDate: _absent, ...sessionCookie } = chromeCookie({ session: true });
	assert.equal("expirationDate" in toSavedCookie(sessionCookie), false);
});

test("toSetDetails builds the url without the leading dot and keeps domain for .claude.ai", () => {
	assert.deepEqual(toSetDetails(toSavedCookie(chromeCookie({ path: "/api" }))), {
		url: "https://claude.ai/api",
		name: "sessionKey",
		value: "fixture",
		path: "/api",
		secure: true,
		httpOnly: true,
		sameSite: "lax",
		domain: ".claude.ai",
		expirationDate: 1893456000,
	});
});

test("toSetDetails omits domain for hostOnly claude.ai cookies", () => {
	const details = toSetDetails(toSavedCookie(chromeCookie({ domain: "claude.ai", hostOnly: true })));
	assert.equal(details.url, "https://claude.ai/");
	assert.equal("domain" in details, false);
});

test("toSetDetails omits expirationDate for session cookies", () => {
	const { expirationDate: _absent, ...sessionCookie } = chromeCookie();
	assert.equal("expirationDate" in toSetDetails(toSavedCookie(sessionCookie)), false);
});

test("summarizeJars reports counts and never cookie contents", () => {
	const jars = {
		work: { savedAt: "2026-01-02T00:00:00.000Z", cookies: [toSavedCookie(chromeCookie())] },
		alt: { savedAt: "2026-01-01T00:00:00.000Z", cookies: [] },
	};
	const summary = summarizeJars(jars);
	assert.deepEqual(summary, [
		{ label: "alt", savedAt: "2026-01-01T00:00:00.000Z", cookieCount: 0 },
		{ label: "work", savedAt: "2026-01-02T00:00:00.000Z", cookieCount: 1 },
	]);
	assert.equal(JSON.stringify(summary).includes("fixture"), false);
});

test("isLabel follows the label pattern", () => {
	for (const label of ["me@example.com", "Work 2", "a.b_c-d"]) assert.equal(isLabel(label), true);
	for (const label of ["", "x".repeat(65), "a/b", "<b>", 3]) assert.equal(isLabel(label), false);
});

test("external callers cannot save or forget accounts", () => {
	assert.equal(EXTERNAL_TYPES.has("accounts.save"), false);
	assert.equal(EXTERNAL_TYPES.has("accounts.forget"), false);
	assert.equal(POPUP_TYPES.has("accounts.save"), true);
	assert.equal(EXTERNAL_TYPES.has("accounts.signIn"), false);
	assert.equal(POPUP_TYPES.has("accounts.signIn"), true);
	assert.deepEqual(
		[...EXTERNAL_TYPES].sort(),
		["accounts.list", "accounts.switch", "ping", "profiles.launch", "profiles.list"],
	);
});

test("inherited Object members are not saved accounts and leave cookies untouched", async () => {
	const removed = [];
	globalThis.chrome = {
		storage: { local: { get: async () => ({}), set: async () => {} } },
		cookies: {
			getAll: async () => [chromeCookie()],
			remove: async (details) => removed.push(details),
			set: async () => {},
		},
		tabs: { query: async () => [], reload: async () => {} },
	};
	try {
		for (const label of ["constructor", "toString", "__proto__"]) {
			assert.equal((await switchAccount(label)).error.code, "not_found");
			assert.equal((await forgetAccount(label)).error.code, "not_found");
		}
		assert.deepEqual(removed, []);
	} finally {
		delete globalThis.chrome;
	}
});
