import test from "node:test";
import assert from "node:assert/strict";
import {
	COOKIE_DOMAINS,
	checkAccounts,
	capturedCookies,
	exportLive,
	forgetAccount,
	importAccount,
	ownsConsole,
	saveAccount,
	signInAnother,
	switchAccount,
	toAccountSummary,
	toSavedCookie,
} from "../lib/jars.js";

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

const cookie = (domain, name, value) => ({
	name,
	value,
	domain,
	path: "/",
	secure: true,
	httpOnly: true,
	sameSite: "lax",
	expirationDate: 1893456000,
	hostOnly: !domain.startsWith("."),
	storeId: "0",
});

const session = (value) => cookie(".claude.ai", "sessionKey", value);
const consoleCookie = (value) => cookie("platform.claude.com", "consoleSession", value);
const consoleWide = (value) => cookie(".claude.com", "consoleOrg", value);

const emails = { A: "a@example.com", B: "b@example.com" };

const hostOf = (url) => new URL(url).hostname;

const matchesDomain = (c, domain) => {
	const host = c.domain.replace(/^\./, "");
	return host === domain || host.endsWith(`.${domain}`);
};

const mockBrowser = (live, store, { probeFails = false } = {}) => {
	let cookies = live.map((c) => ({ ...c }));
	let probed = null;
	const queried = [];
	globalThis.chrome = {
		runtime: { id: "extid" },
		storage: {
			local: {
				get: async (key) => (await yieldTurn(), key in store ? { [key]: structuredClone(store[key]) } : {}),
				set: async (items) => {
					await yieldTurn();
					Object.assign(store, structuredClone(items));
				},
			},
		},
		cookies: {
			getAll: async ({ domain }) => (await yieldTurn(), cookies.filter((c) => matchesDomain(c, domain)).map((c) => ({ ...c }))),
			remove: async ({ url, name }) => {
				cookies = cookies.filter((c) => !(c.name === name && hostOf(url) === c.domain.replace(/^\./, "")));
			},
			set: async (details) => {
				const domain = details.domain ?? hostOf(details.url);
				cookies = [...cookies.filter((c) => !(c.name === details.name && c.domain === domain)), cookie(domain, details.name, details.value)];
			},
		},
		declarativeNetRequest: {
			updateSessionRules: async ({ addRules }) => {
				if (addRules) probed = addRules[0].action.requestHeaders[0].value;
			},
		},
		tabs: {
			query: async (query) => (queried.push(query.url), [{ id: 1 }]),
			reload: async () => {},
			create: async (props) => ({ id: 9, ...props }),
		},
		action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
	};
	globalThis.fetch = async (url) => {
		const header = url.includes("ccp_probe") ? probed : cookies.filter((c) => matchesDomain(c, "claude.ai")).map((c) => `${c.name}=${c.value}`).join("; ");
		const value = header?.match(/sessionKey=(\w+)/)?.[1];
		if (probeFails && value !== "PREV") throw new TypeError("Failed to fetch");
		const email = emails[value];
		return { status: email ? 200 : 401, headers: new Headers(), json: async () => ({ email_address: email }) };
	};
	return {
		live: () => cookies.map((c) => `${c.domain} ${c.name}=${c.value}`).sort(),
		probed: () => probed,
		queried,
	};
};

const restore = () => {
	delete globalThis.chrome;
	delete globalThis.fetch;
};

const jar = (email, ...cookies) => ({
	savedAt: "2026-01-01T00:00:00.000Z",
	email,
	cookies: cookies.map(toSavedCookie),
	check: { status: "ok", checkedAt: "2026-01-01T00:00:00.000Z" },
});

const values = (savedJar) => savedJar.cookies.map((c) => `${c.domain} ${c.name}=${c.value}`).sort();

test("the jar's domains are a list with claude.ai first", () => {
	assert.deepEqual(COOKIE_DOMAINS, ["claude.ai", "claude.com"]);
});

test("the live Console belongs to the label a switch put there, or to whoever signed in after a clear", () => {
	const withConsole = [toSavedCookie(session("A")), toSavedCookie(consoleCookie("CA"))];
	const without = [toSavedCookie(session("A"))];
	assert.equal(ownsConsole("A", "A", without), true);
	assert.equal(ownsConsole("B", "A", withConsole), false);
	assert.equal(ownsConsole(null, "A", withConsole), false);
	assert.equal(ownsConsole("*cleared*", "A", withConsole), true);
	assert.equal(ownsConsole("*cleared*", "A", without), false);
	const held = jar("a@example.com", session("OLD"), consoleCookie("HELD"));
	assert.deepEqual(capturedCookies(held, withConsole, false).map((c) => c.value), ["A", "HELD"]);
	assert.deepEqual(capturedCookies(held, withConsole, true).map((c) => c.value), ["A", "CA"]);
	assert.deepEqual(capturedCookies({}, without, true).map((c) => c.value), ["A"]);
});

test("the summary says whether a Console jar is held, never its cookies", () => {
	assert.equal(toAccountSummary("A", jar("a@example.com", session("A"), consoleCookie("CA"))).consoleJar, true);
	const old = toAccountSummary("B", jar("b@example.com", session("B")));
	assert.equal(old.consoleJar, false);
	assert.equal(old.sessionExpiresAt, "2030-01-01T00:00:00.000Z");
	assert.equal(JSON.stringify(toAccountSummary("A", jar("a@example.com", session("A"), consoleCookie("CA")))).includes("CA"), false);
});

test("switching swaps the Console too, keeps the outgoing Console in its jar and reloads Console tabs", async () => {
	const store = {
		jars: { A: jar("a@example.com", session("A"), consoleCookie("CA-old")), B: jar("b@example.com", session("B"), consoleCookie("CB"), consoleWide("OB")) },
		consoleOwner: "A",
	};
	const browser = mockBrowser([session("A"), consoleCookie("CA")], store);
	try {
		assert.equal((await switchAccount("B")).ok, true);
		assert.deepEqual(browser.live(), [".claude.ai sessionKey=B", ".claude.com consoleOrg=OB", "platform.claude.com consoleSession=CB"]);
		assert.deepEqual(values(store.jars.A), [".claude.ai sessionKey=A", "platform.claude.com consoleSession=CA"]);
		assert.equal(store.consoleOwner, "B");
		assert.deepEqual(browser.queried.at(-1), ["https://claude.ai/*", "https://*.claude.ai/*", "https://claude.com/*", "https://*.claude.com/*"]);
	} finally {
		restore();
	}
});

test("switching to a profile with no Console jar leaves the Console signed out", async () => {
	const store = { jars: { A: jar("a@example.com", session("A"), consoleCookie("CA")), B: jar("b@example.com", session("B")) }, consoleOwner: "A" };
	const browser = mockBrowser([session("A"), consoleCookie("CA")], store);
	try {
		assert.equal((await switchAccount("B")).ok, true);
		assert.deepEqual(browser.live(), [".claude.ai sessionKey=B"]);
		assert.equal(store.consoleOwner, "B");
	} finally {
		restore();
	}
});

test("a Console of unknown owner is cleared on switch and never saved into the outgoing jar", async () => {
	const store = { jars: { A: jar("a@example.com", session("A")), B: jar("b@example.com", session("B")) } };
	const browser = mockBrowser([session("A"), consoleCookie("SOMEONE")], store);
	try {
		assert.equal((await switchAccount("B")).ok, true);
		assert.deepEqual(browser.live(), [".claude.ai sessionKey=B"]);
		assert.deepEqual(values(store.jars.A), [".claude.ai sessionKey=A"]);
	} finally {
		restore();
	}
});

test("a switch whose check fails puts the previous Console and its owner back", async () => {
	emails.PREV = "p@example.com";
	const store = { jars: { B: jar("b@example.com", session("B"), consoleCookie("CB")) }, consoleOwner: null };
	const browser = mockBrowser([session("PREV"), consoleCookie("CP")], store, { probeFails: true });
	try {
		assert.equal((await switchAccount("B")).error.code, "internal");
		assert.deepEqual(browser.live(), [".claude.ai sessionKey=PREV", "platform.claude.com consoleSession=CP"]);
		assert.equal(store.consoleOwner, null);
	} finally {
		delete emails.PREV;
		restore();
	}
});

test("a Console signed in after signing in another account is saved with that account", async () => {
	const store = { jars: { A: jar("a@example.com", session("A")) }, consoleOwner: "A" };
	const browser = mockBrowser([session("A")], store);
	try {
		assert.equal((await signInAnother()).ok, true);
		assert.deepEqual(browser.live(), []);
		assert.equal(store.consoleOwner, "*cleared*");
		await chrome.cookies.set({ url: "https://claude.ai/", domain: ".claude.ai", name: "sessionKey", value: "B" });
		await chrome.cookies.set({ url: "https://platform.claude.com/", name: "consoleSession", value: "CB" });
		const saved = await saveAccount();
		assert.equal(saved.account.consoleJar, true);
		assert.equal(store.consoleOwner, "b@example.com");
		assert.deepEqual(values(store.jars["b@example.com"]), [".claude.ai sessionKey=B", "platform.claude.com consoleSession=CB"]);
	} finally {
		restore();
	}
});

test("checks and exports send claude.ai cookies alone", async () => {
	const store = { jars: { B: jar("b@example.com", session("B"), consoleCookie("CB")) }, consoleOwner: "A" };
	const browser = mockBrowser([session("A"), consoleCookie("CA")], store);
	try {
		const exported = await exportLive();
		assert.deepEqual(exported.cookies.map((c) => c.domain), [".claude.ai"]);
		await checkAccounts();
		assert.equal(browser.probed(), "sessionKey=B");
	} finally {
		restore();
	}
});

test("importing another account's session under a label drops the Console it held", async () => {
	const store = { jars: { work: jar("x@example.com", session("X"), consoleCookie("CX")) } };
	mockBrowser([], store);
	try {
		const imported = await importAccount("work", [toSavedCookie(session("B"))]);
		assert.equal(imported.label, "work");
		assert.deepEqual(values(store.jars.work), [".claude.ai sessionKey=B"]);
	} finally {
		restore();
	}
});

test("importing the same account's fresh session keeps its Console", async () => {
	const store = { jars: { B: jar("b@example.com", session("OLD"), consoleCookie("CB")) } };
	mockBrowser([], store);
	try {
		assert.equal((await importAccount("B", [toSavedCookie(session("B"))])).imported, true);
		assert.deepEqual(values(store.jars.B), [".claude.ai sessionKey=B", "platform.claude.com consoleSession=CB"]);
	} finally {
		restore();
	}
});

test("forgetting the Console's owner leaves the live Console owned by nobody", async () => {
	const store = { jars: { A: jar("a@example.com", session("A")) }, consoleOwner: "A" };
	mockBrowser([session("A"), consoleCookie("CA")], store);
	try {
		assert.equal((await forgetAccount("A")).ok, true);
		assert.equal(store.consoleOwner, null);
	} finally {
		restore();
	}
});
