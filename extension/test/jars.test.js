import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
	cancelRelogin,
	classifyAccountResponse,
	cookieHeader,
	expireRelogin,
	forgetAccount,
	isInfraCookie,
	onCookieChanged,
	probeRule,
	startRelogin,
	summarizeJars,
	switchAccount,
	toAccountSummary,
	toSavedCookie,
	toSetDetails,
} from "../lib/jars.js";
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
	const unchecked = { email: null, status: null, checkedAt: null };
	assert.deepEqual(summary, [
		{ label: "alt", savedAt: "2026-01-01T00:00:00.000Z", cookieCount: 0, ...unchecked, sessionExpiresAt: null },
		{ label: "work", savedAt: "2026-01-02T00:00:00.000Z", cookieCount: 1, ...unchecked, sessionExpiresAt: "2030-01-01T00:00:00.000Z" },
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
		["accounts.list", "accounts.open", "accounts.switch", "ping", "profiles.list"],
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

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

const mockBrowser = (initialCookies, jars, accountFetch) => {
	let cookies = initialCookies.map((c) => ({ ...c }));
	const reloaded = [];
	globalThis.chrome = {
		storage: {
			local: {
				get: async () => (await yieldTurn(), { jars: structuredClone(jars) }),
				set: async (items) => {
					await yieldTurn();
					if (items.jars) jars = items.jars;
				},
			},
		},
		cookies: {
			getAll: async () => (await yieldTurn(), cookies.map((c) => ({ ...c }))),
			remove: async ({ name }) => {
				await yieldTurn();
				cookies = cookies.filter((c) => c.name !== name);
			},
			set: async ({ name, value }) => {
				await yieldTurn();
				cookies = [...cookies.filter((c) => c.name !== name), chromeCookie({ name, value })];
			},
		},
		tabs: { query: async () => [{ id: 1 }], reload: async (id) => reloaded.push(id) },
		action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
	};
	globalThis.fetch = accountFetch;
	return {
		cookies: () => cookies.map(({ name, value }) => `${name}=${value}`).sort(),
		jars: () => jars,
		reloaded,
	};
};

const jarOf = (session, org) => ({
	savedAt: "2026-01-01T00:00:00.000Z",
	cookies: [toSavedCookie(chromeCookie({ value: session })), toSavedCookie(chromeCookie({ name: "lastActiveOrg", value: org }))],
});

const accountResponse = (status, body = {}, headers = {}) => ({
	status,
	headers: new Headers(headers),
	json: async () => body,
});

const restoreGlobals = () => {
	delete globalThis.chrome;
	delete globalThis.fetch;
};

test("a failed session check restores the previous cookies", async () => {
	const browser = mockBrowser([chromeCookie({ value: "PREV" })], { A: jarOf("A", "orgA") }, async () => {
		throw new TypeError("Failed to fetch");
	});
	try {
		const result = await switchAccount("A");
		assert.equal(result.error.code, "internal");
		assert.deepEqual(browser.cookies(), ["sessionKey=PREV"]);
		assert.deepEqual(browser.reloaded, []);
	} finally {
		restoreGlobals();
	}
});

test("concurrent switches run one at a time and never mix cookies", async () => {
	const browser = mockBrowser(
		[chromeCookie({ value: "PREV" })],
		{ A: jarOf("A", "orgA"), B: { ...jarOf("B", "orgB"), cookies: jarOf("B", "orgB").cookies.reverse() } },
		async () => accountResponse(200, { email_address: "x@example.com" }),
	);
	try {
		const results = await Promise.all([switchAccount("A"), switchAccount("B")]);
		assert.deepEqual(results.map((result) => result.ok), [true, true]);
		assert.deepEqual(browser.cookies(), ["lastActiveOrg=orgB", "sessionKey=B"]);
	} finally {
		restoreGlobals();
	}
});

test("external callers never see the switched account's email", async () => {
	const browser = mockBrowser([chromeCookie({ value: "PREV" })], { A: jarOf("A", "orgA") }, async () =>
		accountResponse(200, { email_address: "a@example.com" }),
	);
	const listener = { addListener: () => {} };
	Object.assign(globalThis.chrome, {
		runtime: { onStartup: listener, onInstalled: listener, onMessage: listener, onMessageExternal: listener },
		offscreen: { hasDocument: async () => true },
		alarms: { onAlarm: listener },
	});
	globalThis.chrome.cookies.onChanged = listener;
	try {
		const { dispatch } = await import("../service-worker.js");
		assert.deepEqual(await dispatch({ type: "accounts.switch", label: "A" }, { external: true }), { ok: true, reloadedTabs: 1 });
		assert.equal((await dispatch({ type: "accounts.switch", label: "A" }, { external: false })).email, "a@example.com");
		assert.equal(browser.reloaded.length, 2);
		const listed = await dispatch({ type: "accounts.list" }, { external: true });
		assert.equal("relogin" in listed, false);
		assert.equal(listed.accounts.some((account) => "email" in account), false);
		const popupList = await dispatch({ type: "accounts.list" }, { external: false });
		assert.equal(popupList.accounts[0].email, "a@example.com");
		assert.equal("relogin" in popupList, false);
	} finally {
		restoreGlobals();
		delete globalThis.dispatch;
	}
});

test("only named https origins may message the extension", async () => {
	const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
	for (const match of manifest.externally_connectable.matches) assert.match(match, /^https:\/\//);
});

test("classifyAccountResponse follows the account check rule", () => {
	assert.deepEqual(classifyAccountResponse({ status: 200, email: "a@example.com" }), { status: "ok", email: "a@example.com" });
	assert.deepEqual(classifyAccountResponse({ status: 200, email: undefined }), { status: "unknown" });
	assert.deepEqual(classifyAccountResponse({ status: 401 }), { status: "revoked" });
	assert.deepEqual(classifyAccountResponse({ status: 403, cfMitigated: null }), { status: "revoked" });
	assert.deepEqual(classifyAccountResponse({ status: 403, cfMitigated: "challenge" }), { status: "unknown" });
	assert.deepEqual(classifyAccountResponse({ status: 429 }), { status: "unknown" });
	assert.deepEqual(classifyAccountResponse({ status: 500 }), { status: "unknown" });
});

test("cookieHeader joins name=value pairs", () => {
	assert.equal(cookieHeader([{ name: "a", value: "1" }, { name: "b", value: "2" }]), "a=1; b=2");
	assert.equal(cookieHeader([]), "");
});

test("probeRule sets the cookie header only for the extension's own probe url", () => {
	assert.deepEqual(probeRule(7, "extid", "a=1"), {
		id: 7,
		priority: 1,
		action: { type: "modifyHeaders", requestHeaders: [{ header: "cookie", operation: "set", value: "a=1" }] },
		condition: { urlFilter: "|https://claude.ai/api/account?ccp_probe=7|", initiatorDomains: ["extid"] },
	});
});

test("toAccountSummary reports the email and last check", () => {
	const jar = {
		savedAt: "2026-01-01T00:00:00.000Z",
		cookies: [],
		email: "a@example.com",
		check: { status: "revoked", checkedAt: "2026-01-02T00:00:00.000Z" },
	};
	assert.deepEqual(toAccountSummary("A", jar), {
		label: "A",
		savedAt: "2026-01-01T00:00:00.000Z",
		cookieCount: 0,
		email: "a@example.com",
		status: "revoked",
		checkedAt: "2026-01-02T00:00:00.000Z",
		sessionExpiresAt: null,
	});
});

test("switching away keeps the outgoing account's refreshed session", async () => {
	const emails = { PREV: "b@example.com", A: "a@example.com" };
	const browser = mockBrowser(
		[chromeCookie({ value: "PREV" })],
		{ A: jarOf("A", "orgA"), "b@example.com": jarOf("OLD", "orgB") },
		async () => accountResponse(200, { email_address: emails[browser.cookies().find((c) => c.startsWith("sessionKey="))?.slice(11)] }),
	);
	try {
		assert.equal((await switchAccount("A")).ok, true);
		const kept = browser.jars()["b@example.com"];
		assert.deepEqual(kept.cookies.map((c) => c.value), ["PREV"]);
		assert.equal(kept.check.status, "ok");
		assert.equal(browser.jars().A.email, "a@example.com");
	} finally {
		restoreGlobals();
	}
});

test("a revoked saved session is recorded on a failed switch", async () => {
	const browser = mockBrowser([chromeCookie({ value: "PREV" })], { A: jarOf("A", "orgA") }, async () => accountResponse(401));
	try {
		assert.equal((await switchAccount("A")).error.code, "session_expired");
		assert.equal(browser.jars().A.check.status, "revoked");
		assert.deepEqual(browser.cookies(), ["sessionKey=PREV"]);
	} finally {
		restoreGlobals();
	}
});

const reloginBrowser = ({ running = true } = {}) => {
	const emails = { LIVE: "me@example.com", OLD: null, NEW: "b@example.org" };
	const jarCookieOf = (header) => header.match(/sessionKey=(\w+)/)?.[1];
	let probed = null;
	const browser = mockBrowser(
		[chromeCookie({ value: "LIVE" })],
		{ "me@example.com": jarOf("STALE", "orgA"), "b@example.org": jarOf("OLD", "orgB") },
		async (url) => {
			const session = url.includes("ccp_probe") ? jarCookieOf(probed) : jarCookieOf(browser.cookies().join("; "));
			if (url.includes("ccp_probe") && session === "STALE") return accountResponse(200, { email_address: "me@example.com" });
			return emails[session] ? accountResponse(200, { email_address: emails[session] }) : accountResponse(401);
		},
	);
	const sent = [];
	Object.assign(globalThis.chrome, {
		runtime: {
			id: "extid",
			sendNativeMessage: (_host, msg, reply) => {
				sent.push(msg);
				if (msg.type === "relogin.status") reply({ ok: true, running });
				else if (msg.type === "relogin.stop") reply({ ok: true, stopped: true });
				else reply({ ok: true, order: msg.emails, skipped: [], driver: { profile: null }, log: "/tmp/x.log" });
			},
		},
		declarativeNetRequest: {
			updateSessionRules: async ({ addRules }) => {
				if (addRules) probed = addRules[0].action.requestHeaders[0].value;
			},
		},
		alarms: { create: async () => {}, clear: async () => true },
	});
	const relogin = {};
	const storageSet = globalThis.chrome.storage.local.set;
	const storageGet = globalThis.chrome.storage.local.get;
	Object.assign(globalThis.chrome.storage.local, {
		set: async (items) => (Object.assign(relogin, items.relogin ? { state: items.relogin } : {}), storageSet(items)),
		get: async (key) => (key === "relogin" ? { relogin: relogin.state } : storageGet(key)),
		remove: async () => delete relogin.state,
	});
	return { browser, sent, relogin };
};

test("signing back in records the new session, then restores the profile's own account", async () => {
	const { browser, sent, relogin } = reloginBrowser();
	try {
		const started = await startRelogin();
		assert.equal(started.started, true);
		assert.deepEqual(sent, [{ type: "relogin.start", emails: ["b@example.org"] }]);
		assert.deepEqual(relogin.state.pending, ["b@example.org"]);
		assert.equal(relogin.state.accounts, 1);
		assert.equal(relogin.state.restoreLabel, "me@example.com");
		assert.deepEqual(browser.cookies(), []);
		await globalThis.chrome.cookies.set({ name: "sessionKey", value: "NEW" });
		const settleDelays = [];
		const setTimeoutBefore = globalThis.setTimeout;
		globalThis.setTimeout = (resume, delay) => (settleDelays.push(delay), resume());
		try {
			await onCookieChanged({ removed: false, cookie: { name: "sessionKey", domain: ".claude.ai" } });
		} finally {
			globalThis.setTimeout = setTimeoutBefore;
		}
		assert.deepEqual(settleDelays, [10_000]);
		assert.equal(relogin.state, undefined);
		assert.deepEqual(browser.jars()["b@example.org"].cookies.map((c) => c.value), ["NEW"]);
		assert.equal(browser.jars()["b@example.org"].check.status, "ok");
		assert.deepEqual(browser.cookies(), ["sessionKey=LIVE"]);
		assert.equal(JSON.stringify(started).includes("LIVE"), false);
	} finally {
		restoreGlobals();
	}
});

test("signing back in retries a live check that could not reach claude.ai", async () => {
	const { browser, relogin } = reloginBrowser();
	try {
		await startRelogin();
		await globalThis.chrome.cookies.set({ name: "sessionKey", value: "NEW" });
		const fetchBefore = globalThis.fetch;
		let failures = 1;
		globalThis.fetch = async (...request) => (failures-- > 0 ? Promise.reject(new TypeError("Failed to fetch")) : fetchBefore(...request));
		const settleDelays = [];
		const setTimeoutBefore = globalThis.setTimeout;
		globalThis.setTimeout = (resume, delay) => (settleDelays.push(delay), resume());
		try {
			await onCookieChanged({ removed: false, cookie: { name: "sessionKey", domain: ".claude.ai" } });
		} finally {
			globalThis.setTimeout = setTimeoutBefore;
		}
		assert.deepEqual(settleDelays, [10_000, 10_000]);
		assert.equal(relogin.state, undefined);
		assert.deepEqual(browser.jars()["b@example.org"].cookies.map((c) => c.value), ["NEW"]);
	} finally {
		restoreGlobals();
	}
});

test("cancel stops the driver and restores the profile's own account", async () => {
	const { browser, sent, relogin } = reloginBrowser();
	try {
		await startRelogin();
		await expireRelogin();
		assert.deepEqual(relogin.state.pending, ["b@example.org"]);
		await cancelRelogin();
		assert.deepEqual(sent.map((msg) => msg.type), ["relogin.start", "relogin.status", "relogin.stop"]);
		assert.equal(relogin.state, undefined);
		assert.deepEqual(browser.cookies(), ["sessionKey=LIVE"]);
	} finally {
		restoreGlobals();
	}
});

test("a driver that has exited ends the relogin on the next alarm", async () => {
	const { browser, sent, relogin } = reloginBrowser({ running: false });
	try {
		await startRelogin();
		await expireRelogin();
		assert.deepEqual(sent.map((msg) => msg.type), ["relogin.start", "relogin.status"]);
		assert.equal(relogin.state, undefined);
		assert.deepEqual(browser.cookies(), ["sessionKey=LIVE"]);
	} finally {
		restoreGlobals();
	}
});
