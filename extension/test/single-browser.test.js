import test from "node:test";
import assert from "node:assert/strict";
import {
	classifyPage,
	emailLabel,
	exportLive,
	importAccount,
	isClaudeUrl,
	isSignedOut,
	openAccount,
	saveAccount,
	sessionExpiresAt,
	signInAnother,
	toReport,
	toSavedCookie,
} from "../lib/jars.js";

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

const cookie = (name, value, extra = {}) => ({
	name,
	value,
	domain: ".claude.ai",
	path: "/",
	secure: true,
	httpOnly: true,
	sameSite: "lax",
	expirationDate: 1893456000,
	hostOnly: false,
	storeId: "0",
	...extra,
});

const jarOf = (session, email) => ({
	savedAt: "2026-01-01T00:00:00.000Z",
	email,
	cookies: [toSavedCookie(cookie("sessionKey", session))],
	check: { status: "ok", checkedAt: "2026-01-01T00:00:00.000Z" },
});

const response = (status, body = {}) => ({ status, headers: new Headers(), json: async () => body });

const emails = { A: "a@example.com", B: "b@example.com", FRESH: "b@example.com", PLUS: "a+work@example.com" };

const mockBrowser = (live, jars) => {
	let cookies = [cookie("sessionKey", live)];
	let probed = null;
	const created = [];
	globalThis.chrome = {
		runtime: { id: "extid" },
		storage: {
			local: {
				get: async () => (await yieldTurn(), { jars: structuredClone(jars) }),
				set: async (items) => {
					if (items.jars) jars = items.jars;
				},
			},
		},
		cookies: {
			getAll: async () => cookies.map((c) => ({ ...c })),
			remove: async ({ name }) => {
				cookies = cookies.filter((c) => c.name !== name);
			},
			set: async ({ name, value }) => {
				cookies = [...cookies.filter((c) => c.name !== name), cookie(name, value)];
			},
		},
		declarativeNetRequest: {
			updateSessionRules: async ({ addRules }) => {
				if (addRules) probed = addRules[0].action.requestHeaders[0].value;
			},
		},
		tabs: {
			query: async () => [],
			reload: async () => {},
			create: async (props) => (created.push(props), { id: 9, windowId: 1, ...props }),
			update: async (id, props) => ({ id, windowId: 1, ...props }),
		},
		windows: { update: async () => ({}) },
		action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
	};
	globalThis.fetch = async (url) => {
		const header = url.includes("ccp_probe") ? probed : cookies.map((c) => `${c.name}=${c.value}`).join("; ");
		const session = header?.match(/sessionKey=(\w+)/)?.[1];
		return emails[session] ? response(200, { email_address: emails[session] }) : response(401);
	};
	return {
		jars: () => jars,
		live: () => cookies.find((c) => c.name === "sessionKey")?.value,
		signIn: async (session) => chrome.cookies.set({ name: "sessionKey", value: session }),
		created,
	};
};

const restore = () => {
	delete globalThis.chrome;
	delete globalThis.fetch;
};

test("sessionExpiresAt reads the session cookie's expiry, and expired sessions count as signed out", () => {
	assert.equal(sessionExpiresAt([toSavedCookie(cookie("sessionKey", "x"))]), "2030-01-01T00:00:00.000Z");
	const { expirationDate: _none, ...sessionOnly } = cookie("sessionKey", "x");
	assert.equal(sessionExpiresAt([toSavedCookie(sessionOnly)]), null);
	assert.equal(sessionExpiresAt(undefined), null);
	const base = { label: "a", email: null, status: "ok", checkedAt: null };
	assert.equal(isSignedOut({ ...base, sessionExpiresAt: "2020-01-01T00:00:00.000Z" }), true);
	assert.equal(isSignedOut({ ...base, sessionExpiresAt: null }), false);
	assert.equal(isSignedOut({ ...base, status: "revoked", sessionExpiresAt: null }), true);
	assert.deepEqual(Object.keys(toReport({ ...base, sessionExpiresAt: null, savedAt: "x", cookieCount: 3 })).sort(), [
		"checkedAt",
		"email",
		"label",
		"sessionExpiresAt",
		"status",
	]);
});

test("classifyPage tells a missing session, a sign-in page and a loaded session apart", () => {
	const url = "https://claude.ai/code/session_01ABC";
	assert.equal(classifyPage({ url, text: "This session couldn’t be found", settled: false }), "not-found");
	assert.equal(classifyPage({ url, text: "This session couldn't be found", settled: true }), "not-found");
	assert.equal(classifyPage({ url: "https://claude.ai/login?returnTo=/code", text: "", settled: false }), "signed-out");
	assert.equal(classifyPage({ url, text: "Loading", settled: false }), null);
	assert.equal(classifyPage({ url, text: "Refactor the launcher", settled: true }), "found");
	assert.equal(classifyPage({ url: "not a url", text: "", settled: true }), null);
	assert.equal(isClaudeUrl(url), true);
	for (const bad of ["http://claude.ai/", "https://claude.ai.example.com/", "https://example.com/", "-x"]) assert.equal(isClaudeUrl(bad), false, bad);
});

test("openAccount opens the url without switching when the account is already active", async () => {
	const browser = mockBrowser("A", { A: jarOf("A", "a@example.com"), B: jarOf("B", "b@example.com") });
	try {
		const same = await openAccount("A", "https://claude.ai/code");
		assert.deepEqual([same.ok, same.switched, browser.live()], [true, false, "A"]);
		const other = await openAccount("B", "https://claude.ai/code");
		assert.deepEqual([other.ok, other.switched, browser.live()], [true, true, "B"]);
		assert.deepEqual(browser.created.map((tab) => tab.url), ["https://claude.ai/code", "https://claude.ai/code"]);
		assert.equal((await openAccount("A", "file:///etc/passwd")).error.code, "invalid_request");
		assert.equal((await openAccount("nope", null)).error.code, "not_found");
	} finally {
		restore();
	}
});

test("importAccount saves a live session, keeps a working one, and refuses anything else", async () => {
	const browser = mockBrowser("A", { A: jarOf("A", "a@example.com"), "b@example.com": jarOf("DEAD", "b@example.com") });
	try {
		assert.equal((await importAccount("x", [])).error.code, "invalid_request");
		assert.equal((await importAccount("x", [cookie("lastActiveOrg", "o")])).error.code, "invalid_request");
		assert.equal((await importAccount("x", [cookie("sessionKey", "v", { domain: ".example.com" })])).error.code, "invalid_request");
		assert.equal((await importAccount("x", [cookie("sessionKey", "GONE")])).error.code, "session_expired");
		const kept = await importAccount("a@example.com", [cookie("sessionKey", "A")]);
		assert.deepEqual([kept.imported, kept.label], [false, "A"]);
		const fresh = await importAccount("b@example.com", [cookie("sessionKey", "FRESH"), cookie("__cf_bm", "infra")]);
		assert.deepEqual([fresh.ok, fresh.imported, fresh.label], [true, true, "b@example.com"]);
		assert.deepEqual(browser.jars()["b@example.com"].cookies.map((c) => c.name), ["sessionKey"]);
		assert.equal(JSON.stringify(fresh).includes("FRESH"), false);
		assert.equal(browser.live(), "A");
	} finally {
		restore();
	}
});

test("exportLive hands over the live session only while it is signed in", async () => {
	mockBrowser("A", {});
	try {
		const exported = await exportLive();
		assert.deepEqual([exported.ok, exported.email, exported.cookies.map((c) => c.value)], [true, "a@example.com", ["A"]]);
	} finally {
		restore();
	}
	mockBrowser("GONE", {});
	try {
		assert.equal((await exportLive()).error.code, "session_expired");
	} finally {
		restore();
	}
});

test("saving labels the account with its email, and updates the saved account that already has that email", async () => {
	const browser = mockBrowser("B", { "piggy-main": jarOf("OLD", "a@example.com") });
	try {
		const fresh = await saveAccount();
		assert.deepEqual([fresh.ok, fresh.account.label, fresh.account.email], [true, "b@example.com", "b@example.com"]);
		assert.equal(JSON.stringify(fresh).includes("sessionKey"), false);
		await signInAnother();
		await browser.signIn("A");
		const existing = await saveAccount();
		assert.equal(existing.account.label, "piggy-main");
		assert.deepEqual(Object.keys(browser.jars()).sort(), ["b@example.com", "piggy-main"]);
		assert.equal(browser.jars()["piggy-main"].cookies[0].value, "A");
		assert.equal((await openAccount("piggy-main", null)).email, "a@example.com");
	} finally {
		restore();
	}
});

test("an address with a plus is a label as it stands", async () => {
	mockBrowser("PLUS", {});
	try {
		assert.equal(emailLabel("a+work@example.com"), "a+work@example.com");
		assert.equal((await saveAccount()).account.label, "a+work@example.com");
		assert.equal(emailLabel("o'neil@example.com"), "o_neil@example.com");
	} finally {
		restore();
	}
});

test("signing in another saves the account signed in now first, then opens the sign-in page", async () => {
	const browser = mockBrowser("A", {});
	try {
		const result = await signInAnother();
		assert.deepEqual([result.ok, result.saved.label], [true, "a@example.com"]);
		assert.equal(browser.jars()["a@example.com"].cookies[0].value, "A");
		assert.equal(browser.live(), undefined);
		assert.deepEqual(browser.created.map((tab) => tab.url), ["https://claude.ai/login"]);
		const signedOut = await signInAnother();
		assert.deepEqual([signedOut.ok, signedOut.saved], [true, null]);
	} finally {
		restore();
	}
});

test("saving never overwrites a saved account that holds another email", async () => {
	const browser = mockBrowser("B", { "a@example.com": jarOf("A", "a@example.com") });
	try {
		assert.equal((await saveAccount("a@example.com")).error.code, "invalid_request");
		assert.equal((await signInAnother()).ok, true);
		assert.equal(browser.jars()["a@example.com"].cookies[0].value, "A");
		assert.equal(browser.jars()["b@example.com"].cookies[0].value, "B");
	} finally {
		restore();
	}
});
