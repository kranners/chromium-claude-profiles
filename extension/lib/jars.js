import { failure, isLabel } from "./protocol.js";

const STORAGE_KEY = "jars";
const COOKIE_DOMAIN = "claude.ai";
const SESSION_COOKIE = "sessionKey";
const ACCOUNT_URL = "https://claude.ai/api/account";
const CLAUDE_TAB_PATTERNS = ["https://claude.ai/*", "https://*.claude.ai/*"];
const INFRA_COOKIES = new Set(["__cf_bm", "cf_clearance", "_cfuvid", "__cflb"]);

export const isInfraCookie = (name) => INFRA_COOKIES.has(name);

export const cookieUrl = ({ domain, path }) => `https://${domain.replace(/^\./, "")}${path}`;

export const toSavedCookie = (c) => ({
	name: c.name,
	value: c.value,
	domain: c.domain,
	path: c.path,
	secure: c.secure,
	httpOnly: c.httpOnly,
	sameSite: c.sameSite,
	...(c.expirationDate === undefined ? {} : { expirationDate: c.expirationDate }),
	hostOnly: c.hostOnly,
});

export const toSetDetails = (saved) => ({
	url: cookieUrl(saved),
	name: saved.name,
	value: saved.value,
	path: saved.path,
	secure: saved.secure,
	httpOnly: saved.httpOnly,
	sameSite: saved.sameSite,
	...(saved.hostOnly ? {} : { domain: saved.domain }),
	...(saved.expirationDate === undefined ? {} : { expirationDate: saved.expirationDate }),
});

export const toAccountSummary = (label, jar) => ({
	label,
	savedAt: jar.savedAt,
	cookieCount: jar.cookies.length,
});

export const summarizeJars = (jars) =>
	Object.entries(jars)
		.map(([label, jar]) => toAccountSummary(label, jar))
		.sort((a, b) => a.label.localeCompare(b.label));

const readJars = async () => (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] ?? {};

const writeJars = (jars) => chrome.storage.local.set({ [STORAGE_KEY]: jars });

const accountCookies = async () =>
	(await chrome.cookies.getAll({ domain: COOKIE_DOMAIN })).filter((c) => !isInfraCookie(c.name));

const invalidLabel = () => failure("invalid_request", "Label must match ^[A-Za-z0-9 ._@-]{1,64}$");

const unknownLabel = (label) => failure("not_found", `No saved account "${label}"`);

const savedJar = (jars, label) => (Object.hasOwn(jars, label) ? jars[label] : undefined);

const signedInEmail = async () => {
	const response = await fetch(ACCOUNT_URL, { credentials: "include", cache: "no-store" });
	if (!response.ok) return null;
	return (await response.json()).email_address ?? null;
};

let queue = Promise.resolve();

const serial =
	(fn) =>
	(...args) => {
		const run = queue.then(() => fn(...args));
		queue = run.catch(() => undefined);
		return run;
	};

export const listAccounts = async () => ({ ok: true, accounts: summarizeJars(await readJars()) });

export const saveAccount = serial(async (label) => {
	if (!isLabel(label)) return invalidLabel();
	const cookies = await accountCookies();
	if (!cookies.some((c) => c.name === SESSION_COOKIE)) {
		return failure("invalid_request", "Not signed in to claude.ai");
	}
	if (!(await signedInEmail())) return failure("session_expired", "This claude.ai session is signed out. Sign in again first.");
	const jar = { savedAt: new Date().toISOString(), cookies: cookies.map(toSavedCookie) };
	await writeJars({ ...(await readJars()), [label]: jar });
	return { ok: true, account: toAccountSummary(label, jar) };
});

const clearAccountCookies = async () => {
	for (const c of await accountCookies()) {
		await chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId });
	}
};

export const signInAnother = serial(async () => {
	await clearAccountCookies();
	await chrome.tabs.create({ url: "https://claude.ai/login" });
	return { ok: true };
});

const replaceAccountCookies = async (cookies) => {
	await clearAccountCookies();
	for (const saved of cookies) {
		await chrome.cookies.set(toSetDetails(saved));
	}
};

export const switchAccount = serial(async (label) => {
	if (!isLabel(label)) return invalidLabel();
	const jar = savedJar(await readJars(), label);
	if (!Array.isArray(jar?.cookies)) return unknownLabel(label);
	const previous = (await accountCookies()).map(toSavedCookie);
	const email = await replaceAccountCookies(jar.cookies).then(signedInEmail).catch(() => null);
	if (!email) {
		await replaceAccountCookies(previous);
		return failure("session_expired", `The saved session for "${label}" is no longer valid. Sign in to it again and re-save it.`);
	}
	const tabs = await chrome.tabs.query({ url: CLAUDE_TAB_PATTERNS });
	await Promise.all(tabs.map((tab) => chrome.tabs.reload(tab.id)));
	return { ok: true, email, reloadedTabs: tabs.length };
});

export const forgetAccount = serial(async (label) => {
	if (!isLabel(label)) return invalidLabel();
	const jars = await readJars();
	if (!savedJar(jars, label)) return unknownLabel(label);
	const { [label]: _forgotten, ...rest } = jars;
	await writeJars(rest);
	return { ok: true };
});
