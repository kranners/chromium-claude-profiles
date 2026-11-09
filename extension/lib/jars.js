import { failure, isLabel } from "./protocol.js";
import { sendNative } from "./native.js";
import { sendBridge } from "./bridge.js";

const STORAGE_KEY = "jars";
const RELOGIN_KEY = "relogin";
const RELOGIN_MINUTES = 20;
const RELOGIN_MINUTES_PER_ACCOUNT = 6;
const LIVE_CHECK_ATTEMPTS = 3;
const SIGN_IN_SETTLE_MS = 10_000;
const RELOGIN_EXPIRE_ALARM = "relogin-expire";
const BADGE_COLOR = "#b3261e";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

export const sessionExpiresAt = (cookies) => {
	const seconds = (Array.isArray(cookies) ? cookies : []).find((c) => c?.name === SESSION_COOKIE)?.expirationDate;
	return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
};

export const toAccountSummary = (label, jar) => ({
	label,
	savedAt: jar.savedAt,
	cookieCount: jar.cookies.length,
	email: jar.email ?? null,
	status: jar.check?.status ?? null,
	checkedAt: jar.check?.checkedAt ?? null,
	sessionExpiresAt: sessionExpiresAt(jar.cookies),
});

export const isSignedOut = (summary, now = Date.now()) =>
	summary.status === "revoked" || (summary.sessionExpiresAt !== null && Date.parse(summary.sessionExpiresAt) <= now);

export const toReport = (summary) => ({
	label: summary.label,
	email: summary.email,
	status: summary.status,
	checkedAt: summary.checkedAt,
	sessionExpiresAt: summary.sessionExpiresAt,
});

export const classifyAccountResponse = ({ status, cfMitigated, email }) => {
	if (status === 200 && typeof email === "string" && email) return { status: "ok", email };
	if (status === 401 || (status === 403 && !cfMitigated)) return { status: "revoked" };
	return { status: "unknown" };
};

export const cookieHeader = (cookies) => cookies.map(({ name, value }) => `${name}=${value}`).join("; ");

const probeUrl = (id) => `${ACCOUNT_URL}?ccp_probe=${id}`;

export const probeRule = (id, extensionId, header) => ({
	id,
	priority: 1,
	action: { type: "modifyHeaders", requestHeaders: [{ header: "cookie", operation: "set", value: header }] },
	condition: { urlFilter: `|${probeUrl(id)}|`, initiatorDomains: [extensionId] },
});

export const summarizeJars = (jars) =>
	Object.entries(jars)
		.map(([label, jar]) => toAccountSummary(label, jar))
		.sort((a, b) => a.label.localeCompare(b.label));

export const readJars = async () => (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] ?? {};

const revokedCount = (jars) => summarizeJars(jars).filter((summary) => isSignedOut(summary)).length;

const updateBadge = async (jars) => {
	const count = revokedCount(jars);
	await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
	await chrome.action.setBadgeText({ text: count ? String(count) : "" });
};

const reportJars = (jars) => sendBridge({ type: "accounts.report", accounts: summarizeJars(jars).map(toReport) });

const writeJars = async (jars) => {
	await chrome.storage.local.set({ [STORAGE_KEY]: jars });
	await updateBadge(jars);
	reportJars(jars);
};

const claudeCookies = () => chrome.cookies.getAll({ domain: COOKIE_DOMAIN });

const accountCookies = async () => (await claudeCookies()).filter((c) => !isInfraCookie(c.name));

const infraCookies = async () => (await claudeCookies()).filter((c) => isInfraCookie(c.name));

const invalidLabel = () => failure("invalid_request", "Label must match ^[A-Za-z0-9 ._@-]{1,64}$");

const unknownLabel = (label) => failure("not_found", `No saved account "${label}"`);

const savedJar = (jars, label) => (Object.hasOwn(jars, label) ? jars[label] : undefined);

const unknownResult = () => ({ status: "unknown" });

const responseEmail = (response) =>
	response.status === 200 ? response.json().then((body) => body?.email_address, () => null) : null;

const classifyResponse = async (response) =>
	classifyAccountResponse({
		status: response.status,
		cfMitigated: response.headers.get("cf-mitigated"),
		email: await responseEmail(response),
	});

const fetchAccount = (url, credentials) =>
	fetch(url, { credentials, cache: "no-store" }).then(classifyResponse, unknownResult);

const checkLive = () => fetchAccount(ACCOUNT_URL, "include");

let probeId = Date.now() % 1e6;

const checkJar = async (jar) => {
	const id = ++probeId;
	const header = cookieHeader([...jar.cookies, ...(await infraCookies())]);
	await chrome.declarativeNetRequest.updateSessionRules({ addRules: [probeRule(id, chrome.runtime.id, header)] });
	try {
		return await fetchAccount(probeUrl(id), "omit");
	} finally {
		await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
	}
};

const sameEmail = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

const labelForEmail = (jars, email) =>
	Object.keys(jars).find((label) => sameEmail(jars[label].email, email)) ??
	Object.keys(jars).find((label) => sameEmail(label, email)) ??
	null;

const withCheck = (jar, result, checkedAt) => ({
	...jar,
	...(result.status === "ok" ? { email: result.email } : {}),
	check: { status: result.status, checkedAt },
});

const withCookies = (jar, cookies, result) => {
	const savedAt = new Date().toISOString();
	return { ...withCheck(jar, result, savedAt), savedAt, cookies };
};

const checkFailed = () => failure("internal", "Couldn't reach claude.ai to check the session. Try again.");

let queue = Promise.resolve();
let pendingOps = 0;
let lastSwitchAt = 0;

// True while any queued account operation is waiting or running; auto-swap stays out of its way.
export const isBusy = () => pendingOps > 0;

// Milliseconds since the cookie jar last changed account, so auto-swap ignores the reloads that causes.
export const msSinceSwitch = () => Date.now() - lastSwitchAt;

export const serial =
	(fn) =>
	(...args) => {
		pendingOps++;
		const run = queue.then(() => fn(...args)).finally(() => pendingOps--);
		queue = run.catch(() => undefined);
		return run;
	};

export const listAccounts = async () => ({ ok: true, accounts: summarizeJars(await readJars()) });

const checkAllJars = async () => {
	const results = await Promise.all(
		Object.entries(await readJars()).map(async ([label, jar]) => [label, await checkJar(jar).catch(unknownResult)]),
	);
	const checkedAt = new Date().toISOString();
	const jars = await readJars();
	for (const [label, result] of results) {
		if (savedJar(jars, label)) jars[label] = withCheck(jars[label], result, checkedAt);
	}
	await writeJars(jars);
	return listAccounts();
};

export const checkAccounts = serial(checkAllJars);

export const saveAccount = serial(async (label) => {
	if (!isLabel(label)) return invalidLabel();
	const cookies = await accountCookies();
	if (!cookies.some((c) => c.name === SESSION_COOKIE)) {
		return failure("invalid_request", "Not signed in to claude.ai");
	}
	const live = await checkLive();
	if (live.status === "revoked") return failure("session_expired", "This claude.ai session is signed out. Sign in again first.");
	if (live.status !== "ok") return checkFailed();
	const jar = withCookies({}, cookies.map(toSavedCookie), live);
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

const reloadClaudeTabs = async () => {
	const tabs = await chrome.tabs.query({ url: CLAUDE_TAB_PATTERNS });
	await Promise.all(tabs.map((tab) => chrome.tabs.reload(tab.id)));
	return tabs.length;
};

const updateJar = async (label, update) => {
	const jars = await readJars();
	if (savedJar(jars, label)) await writeJars({ ...jars, [label]: update(jars[label]) });
};

const keepOutgoingSession = async (outgoing, cookies) => {
	if (outgoing.status !== "ok") return;
	const label = labelForEmail(await readJars(), outgoing.email);
	if (label !== null) await updateJar(label, (jar) => withCookies(jar, cookies, outgoing));
};

export const doSwitch = async (label) => {
	if (!isLabel(label)) return invalidLabel();
	lastSwitchAt = Date.now();
	const jar = savedJar(await readJars(), label);
	if (!Array.isArray(jar?.cookies)) return unknownLabel(label);
	const previous = (await accountCookies()).map(toSavedCookie);
	const outgoing = await checkLive();
	const result = await replaceAccountCookies(jar.cookies).then(checkLive).catch(unknownResult);
	if (result.status !== "ok") {
		await replaceAccountCookies(previous);
		if (result.status !== "revoked") return checkFailed();
		await updateJar(label, (saved) => withCheck(saved, result, new Date().toISOString()));
		return failure("session_expired", `The saved session for "${label}" is no longer valid. Sign in to it again and re-save it.`);
	}
	await updateJar(label, (saved) => withCheck(saved, result, new Date().toISOString()));
	await keepOutgoingSession(outgoing, previous);
	const reloadedTabs = await reloadClaudeTabs();
	lastSwitchAt = Date.now();
	return { ok: true, email: result.email, reloadedTabs };
};

export const switchAccount = serial(doSwitch);

export const forgetAccount = serial(async (label) => {
	if (!isLabel(label)) return invalidLabel();
	const jars = await readJars();
	if (!savedJar(jars, label)) return unknownLabel(label);
	const { [label]: _forgotten, ...rest } = jars;
	await writeJars(rest);
	return { ok: true };
});

const readRelogin = async () => (await chrome.storage.local.get(RELOGIN_KEY))[RELOGIN_KEY] ?? null;

const reloginMinutes = (accounts) => Math.max(RELOGIN_MINUTES, accounts * RELOGIN_MINUTES_PER_ACCOUNT);

const isExpired = (state) => Date.now() - Date.parse(state.startedAt) > reloginMinutes(state.accounts) * 60_000;

const endRelogin = async (state) => {
	await chrome.alarms.clear(RELOGIN_EXPIRE_ALARM);
	const restore = state.restoreLabel === null ? undefined : savedJar(await readJars(), state.restoreLabel);
	if (Array.isArray(restore?.cookies)) await replaceAccountCookies(restore.cookies);
	await reloadClaudeTabs();
	await chrome.storage.local.remove(RELOGIN_KEY);
	return { ...(await checkAllJars()), relogin: null };
};

const stopRelogin = async (state) => {
	await sendNative({ type: "relogin.stop" });
	return endRelogin(state);
};

const activeRelogin = async () => {
	const state = await readRelogin();
	if (state && isExpired(state)) {
		await stopRelogin(state);
		return null;
	}
	return state;
};

export const reloginStatus = async () => {
	const state = await readRelogin();
	return { ok: true, relogin: state && !isExpired(state) ? state : null };
};

const driverRunning = async () => {
	const response = await sendNative({ type: "relogin.status" });
	return !response.ok || response.running;
};

export const expireRelogin = serial(async () => {
	const state = await activeRelogin();
	if (state && !(await driverRunning())) await endRelogin(state);
});

const emailOf = (label, jar) => jar.email ?? (EMAIL_PATTERN.test(label) ? label : null);

const staleEmails = (jars) => [
	...new Set(
		Object.entries(jars)
			.filter(([, jar]) => jar.check?.status === "revoked")
			.map(([label, jar]) => emailOf(label, jar)?.toLowerCase())
			.filter(Boolean),
	),
];

export const startRelogin = serial(async () => {
	if (await activeRelogin()) return failure("invalid_request", "Already signing back in");
	await checkAllJars();
	const live = await checkLive();
	if (live.status === "unknown") return checkFailed();
	const restoreLabel = live.status === "ok" ? labelForEmail(await readJars(), live.email) : null;
	if (restoreLabel !== null) {
		const cookies = (await accountCookies()).map(toSavedCookie);
		await updateJar(restoreLabel, (jar) => withCookies(jar, cookies, live));
	}
	const stale = staleEmails(await readJars());
	if (!stale.length) return { ok: true, started: false, message: "No signed-out accounts" };
	if (live.status === "ok" && restoreLabel === null) {
		return failure("invalid_request", "Save the current claude.ai account first; signing back in signs these tabs out.");
	}
	const response = await sendNative({ type: "relogin.start", emails: stale });
	if (!response.ok) return response;
	await chrome.storage.local.set({
		[RELOGIN_KEY]: {
			pending: response.order.map((email) => email.toLowerCase()),
			accounts: response.order.length,
			restoreLabel,
			startedAt: new Date().toISOString(),
			log: response.log ?? null,
		},
	});
	await chrome.alarms.create(RELOGIN_EXPIRE_ALARM, { periodInMinutes: 1 });
	await clearAccountCookies();
	return { ok: true, started: true, order: response.order, skipped: response.skipped, driver: response.driver };
});

export const cancelRelogin = serial(async () => {
	const state = await readRelogin();
	return state ? stopRelogin(state) : { ...(await listAccounts()), relogin: null };
});

const settleSignIn = () => new Promise((resolve) => setTimeout(resolve, SIGN_IN_SETTLE_MS));

const settledLive = async (attempts = LIVE_CHECK_ATTEMPTS) => {
	await settleSignIn();
	const live = await checkLive();
	return live.status === "unknown" && attempts > 1 ? settledLive(attempts - 1) : live;
};

const captureRelogin = serial(async () => {
	const state = await activeRelogin();
	if (!state) return;
	const live = await settledLive();
	const email = live.status === "ok" ? live.email.toLowerCase() : null;
	if (!state.pending.includes(email)) return;
	const jars = await readJars();
	const label = labelForEmail(jars, email) ?? email;
	if (!isLabel(label)) return;
	const cookies = (await accountCookies()).map(toSavedCookie);
	await writeJars({ ...jars, [label]: withCookies(savedJar(jars, label) ?? {}, cookies, live) });
	const pending = state.pending.filter((pendingEmail) => pendingEmail !== email);
	if (!pending.length) {
		await endRelogin(state);
		return;
	}
	await chrome.storage.local.set({ [RELOGIN_KEY]: { ...state, pending } });
	await clearAccountCookies();
});

export const onCookieChanged = ({ removed, cookie }) => {
	if (!removed && cookie.name === SESSION_COOKIE && cookie.domain.endsWith(COOKIE_DOMAIN)) {
		return captureRelogin().catch(() => undefined);
	}
};

const isWebUrl = (url) => {
	if (typeof url !== "string" || url.startsWith("-")) return false;
	try {
		return ["https:", "http:"].includes(new URL(url).protocol);
	} catch {
		return false;
	}
};

export const isClaudeUrl = (url) => {
	if (!isWebUrl(url)) return false;
	const { protocol, hostname } = new URL(url);
	return protocol === "https:" && (hostname === COOKIE_DOMAIN || hostname.endsWith(`.${COOKIE_DOMAIN}`));
};

export const activeLabel = async (jars) => {
	const live = await checkLive();
	return live.status === "ok" ? labelForEmail(jars, live.email) : null;
};

const listWithActive = async () => {
	const jars = await readJars();
	return { ok: true, accounts: summarizeJars(jars), active: await activeLabel(jars) };
};

export const listForBridge = serial(async () => {
	reportJars(await readJars());
	return listWithActive();
});

export const checkForBridge = serial(async () => {
	await checkAllJars();
	return listWithActive();
});

const focusTab = async (tab) => {
	if (tab?.windowId !== undefined) await chrome.windows?.update(tab.windowId, { focused: true }).catch(() => undefined);
	return tab;
};

const claudeTab = async () => {
	const [existing] = await chrome.tabs.query({ url: CLAUDE_TAB_PATTERNS });
	return existing ? chrome.tabs.update(existing.id, { active: true }) : chrome.tabs.create({ url: "https://claude.ai/", active: true });
};

export const openAccount = serial(async (label, url) => {
	if (!isLabel(label)) return invalidLabel();
	if (url !== null && url !== undefined && !isWebUrl(url)) return failure("invalid_request", "url must be an http or https URL");
	const jars = await readJars();
	const jar = savedJar(jars, label);
	if (!Array.isArray(jar?.cookies)) return unknownLabel(label);
	let switched = false;
	let reloadedTabs = 0;
	if ((await activeLabel(jars)) !== label) {
		const result = await doSwitch(label);
		if (!result.ok) return result;
		switched = true;
		reloadedTabs = result.reloadedTabs;
	}
	const tab = await focusTab(url ? await chrome.tabs.create({ url, active: true }) : await claudeTab());
	return { ok: true, label, email: jar.email ?? null, switched, reloadedTabs, tabId: tab?.id ?? null };
});

const NOT_FOUND = /couldn[’']?t be found|could not be found|not found|doesn[’']?t exist|does not exist|don[’']?t have access|do not have access/i;

export const classifyPage = ({ url, text, settled }) => {
	let path = "";
	try {
		path = new URL(url).pathname;
	} catch {
		return null;
	}
	if (/^\/(login|magic-link)\b/.test(path)) return "signed-out";
	if (NOT_FOUND.test(text ?? "")) return "not-found";
	return settled ? "found" : null;
};

const PAGE_LOAD_MS = 20_000;
const PAGE_SETTLE_MS = 8_000;
const PAGE_GIVE_UP_MS = 25_000;
const PAGE_POLL_MS = 500;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pageText = async (tabId) => {
	const [frame] = await chrome.scripting
		.executeScript({ target: { tabId }, func: () => document.body?.innerText?.slice(0, 4000) ?? "" })
		.catch(() => []);
	return typeof frame?.result === "string" ? frame.result : "";
};

export const waitForVerdict = async (tabId, classify = classifyPage) => {
	const started = Date.now();
	let loadedAt = null;
	while (Date.now() - started < PAGE_GIVE_UP_MS) {
		const tab = await chrome.tabs.get(tabId).catch(() => null);
		if (!tab) return "closed";
		if (tab.status === "complete" && loadedAt === null) loadedAt = Date.now();
		if (loadedAt === null && Date.now() - started > PAGE_LOAD_MS) loadedAt = Date.now();
		if (loadedAt !== null) {
			const verdict = classify({ url: tab.url ?? "", text: await pageText(tabId), settled: Date.now() - loadedAt >= PAGE_SETTLE_MS });
			if (verdict) return verdict;
		}
		await pause(PAGE_POLL_MS);
	}
	return "found";
};

export const openFor = serial(async (url) => {
	if (!isClaudeUrl(url)) return failure("invalid_request", "open-for takes an https://claude.ai/ link");
	const jars = await readJars();
	const startedOn = await activeLabel(jars);
	const order = [
		...(startedOn ? [startedOn] : []),
		...Object.keys(jars)
			.filter((label) => label !== startedOn && jars[label].check?.status !== "revoked")
			.sort(),
	];
	if (!order.length) return failure("not_found", "No signed-in saved account to try");
	const tried = [];
	let tab = null;
	for (const label of order) {
		if (tried.length > 0 || label !== startedOn) {
			const switched = await doSwitch(label);
			if (!switched.ok) {
				tried.push({ label, result: switched.error.code === "session_expired" ? "signed-out" : "error" });
				continue;
			}
		}
		tab = tab ? await chrome.tabs.update(tab.id, { url, active: true }) : await chrome.tabs.create({ url, active: true });
		const result = await waitForVerdict(tab.id);
		tried.push({ label, result });
		if (result === "found") {
			await focusTab(tab);
			return { ok: true, label, email: savedJar(jars, label)?.email ?? null, tabId: tab.id, tried };
		}
		if (result === "closed") tab = null;
	}
	if (tab) await chrome.tabs.remove(tab.id).catch(() => undefined);
	if (startedOn && tried.at(-1)?.label !== startedOn) await doSwitch(startedOn).catch(() => undefined);
	const summary = tried.map(({ label, result }) => `${label}: ${result}`).join(", ");
	return failure("not_found", `No saved account could see that link (${summary})`);
});

export const exportLive = serial(async () => {
	const live = await checkLive();
	if (live.status === "revoked") return failure("session_expired", "Not signed in to claude.ai");
	if (live.status !== "ok") return checkFailed();
	return { ok: true, email: live.email, cookies: (await accountCookies()).map(toSavedCookie) };
});

const MAX_IMPORT_COOKIES = 200;

const toImportedCookie = (c) =>
	typeof c?.name === "string" &&
	typeof c.value === "string" &&
	typeof c.domain === "string" &&
	(c.domain.replace(/^\./, "") === COOKIE_DOMAIN || c.domain.endsWith(`.${COOKIE_DOMAIN}`)) &&
	typeof c.path === "string"
		? toSavedCookie(c)
		: null;

const importLabel = (label, email) => (isLabel(label) ? label : email.replace(/[^A-Za-z0-9 ._@-]/g, "_").slice(0, 64));

export const importAccount = serial(async (label, cookies) => {
	if (!Array.isArray(cookies) || cookies.length === 0 || cookies.length > MAX_IMPORT_COOKIES) {
		return failure("invalid_request", "cookies must be a non-empty list");
	}
	const saved = cookies.filter((c) => !isInfraCookie(c?.name)).map(toImportedCookie);
	if (saved.includes(null) || !saved.some((c) => c.name === SESSION_COOKIE)) {
		return failure("invalid_request", "Not a claude.ai session");
	}
	const result = await checkJar({ cookies: saved }).catch(unknownResult);
	if (result.status === "revoked") return failure("session_expired", "That session is signed out");
	if (result.status !== "ok") return checkFailed();
	const jars = await readJars();
	const existing = labelForEmail(jars, result.email);
	if (existing !== null && (await checkJar(jars[existing]).catch(unknownResult)).status === "ok") {
		return { ok: true, imported: false, label: existing, email: result.email };
	}
	const target = existing ?? importLabel(typeof label === "string" ? label : "", result.email);
	const current = await readJars();
	await writeJars({ ...current, [target]: withCookies(savedJar(current, target) ?? {}, saved, result) });
	return { ok: true, imported: true, label: target, email: result.email };
});
