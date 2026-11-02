import { failure, isLabel } from "./protocol.js";
import { sendNative } from "./native.js";

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

export const toAccountSummary = (label, jar) => ({
	label,
	savedAt: jar.savedAt,
	cookieCount: jar.cookies.length,
	email: jar.email ?? null,
	status: jar.check?.status ?? null,
	checkedAt: jar.check?.checkedAt ?? null,
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

const readJars = async () => (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] ?? {};

const revokedCount = (jars) => Object.values(jars).filter((jar) => jar.check?.status === "revoked").length;

const updateBadge = async (jars) => {
	const count = revokedCount(jars);
	await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
	await chrome.action.setBadgeText({ text: count ? String(count) : "" });
};

const writeJars = async (jars) => {
	await chrome.storage.local.set({ [STORAGE_KEY]: jars });
	await updateBadge(jars);
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

const serial =
	(fn) =>
	(...args) => {
		const run = queue.then(() => fn(...args));
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

export const switchAccount = serial(async (label) => {
	if (!isLabel(label)) return invalidLabel();
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
	return { ok: true, email: result.email, reloadedTabs: await reloadClaudeTabs() };
});

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
