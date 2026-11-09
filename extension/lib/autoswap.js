import {
	SETTINGS_KEY,
	classifyLinkPage,
	isMissingText,
	linkKey,
	normalizeSettings,
	redirectedAway,
	resolveLink,
	skipReason,
	withOptOut,
	withOwner,
	withoutOwner,
} from "./autoswap-logic.js";
import { activeLabel, doSwitch, isBusy, msSinceSwitch, readJars, serial, waitForVerdict } from "./jars.js";
import { failure } from "./protocol.js";

const DEBOUNCE_MS = 1500;
const BUSY_RETRY_MS = 3000;
const BUSY_RETRIES = 3;

const handled = new Map();
const unresolved = new Map();
const timers = new Map();
const lastLink = new Map();

let settingsQueue = Promise.resolve();

export const readSettings = async () => normalizeSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);

// Every read-modify-write goes through one chain so the popup and a running swap cannot lose each other's change.
const updateSettings = (update) => {
	const run = settingsQueue.then(async () => {
		const next = update(await readSettings());
		await chrome.storage.local.set({ [SETTINGS_KEY]: next });
		return next;
	});
	settingsQueue = run.catch(() => undefined);
	return run;
};

const recordLast = (key, outcome, label) => ({ key, outcome, label: label ?? null, at: new Date().toISOString() });

const usableLabels = (jars) => Object.keys(jars).filter((label) => jars[label].check?.status !== "revoked");

const showLink = async (tabId, url) => {
	const tab = await chrome.tabs.get(tabId).catch(() => null);
	if (tab && linkKey(tab.url ?? "") !== linkKey(url)) await chrome.tabs.update(tabId, { url });
};

const swapForTab = serial(async (tabId, url, key, activeMissing = false) => {
	const settings = await readSettings();
	const jars = await readJars();
	const deps = {
		verdict: () => waitForVerdict(tabId, (page) => classifyLinkPage({ ...page, key })),
		switchTo: async (label) => (await doSwitch(label)).ok === true,
		show: () => showLink(tabId, url),
	};
	const result = await resolveLink({
		cachedLabel: settings.cache[key] ?? null,
		active: await activeLabel(jars),
		labels: usableLabels(jars),
		deps,
		activeMissing,
	});
	if (result.outcome === "swapped" || result.outcome === "stay") {
		if (result.tried.length) await updateSettings((s) => withOwner(s, key, result.label));
	}
	if (result.outcome === "unresolved") unresolved.set(key, Date.now());
	if (result.outcome === "swapped") {
		const tab = await chrome.tabs.get(tabId).catch(() => null);
		if (tab?.windowId !== undefined) await chrome.windows?.update(tab.windowId, { focused: true }).catch(() => undefined);
	}
	if (result.outcome !== "skipped") await updateSettings((s) => ({ ...s, last: recordLast(key, result.outcome, result.label) }));
	return result;
});

const confirmBanner = (tabId) =>
	chrome.scripting
		.executeScript({
			target: { tabId },
			func: () => {
				if (document.getElementById("ccp-autoswap-banner")) return;
				const host = document.createElement("div");
				host.id = "ccp-autoswap-banner";
				const shadow = host.attachShadow({ mode: "closed" });
				const box = document.createElement("div");
				box.style.cssText =
					"position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;padding:12px 14px;border-radius:10px;background:#1f1e1d;color:#f5f4ee;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35)";
				const text = document.createElement("div");
				text.textContent =
					"Claude Profiles can switch to the saved account that owns a claude.ai link like this one, then reload the tab. Switching reloads every claude.ai tab. Turn it on?";
				const row = document.createElement("div");
				row.style.cssText = "margin-top:10px;display:flex;gap:8px;justify-content:flex-end";
				const choose = (enabled) => {
					chrome.runtime.sendMessage({ type: "autoswap.setEnabled", enabled });
					host.remove();
				};
				for (const [label, enabled] of [["Not now", false], ["Turn on", true]]) {
					const button = document.createElement("button");
					button.textContent = label;
					button.style.cssText =
						"cursor:pointer;border:0;border-radius:6px;padding:6px 12px;font:inherit;" +
						(enabled ? "background:#d97757;color:#fff" : "background:#3a3937;color:#f5f4ee");
					button.onclick = () => choose(enabled);
					row.append(button);
				}
				box.append(text, row);
				shadow.append(box);
				document.documentElement.append(host);
			},
		})
		.catch(() => undefined);

const pageText = async (tabId) => {
	const [frame] = await chrome.scripting
		.executeScript({ target: { tabId }, func: () => document.body?.innerText?.slice(0, 4000) ?? "" })
		.catch(() => []);
	return typeof frame?.result === "string" ? frame.result : "";
};

// The tab shows the link itself, or was sent away from it moments ago and says the link was not available.
const handleTab = async (tabId, attempt = 0) => {
	const tab = await chrome.tabs.get(tabId).catch(() => null);
	if (!tab?.url || tab.incognito) return;
	let key = linkKey(tab.url);
	let url = tab.url;
	let activeMissing = false;
	if (key === null) {
		const pending = lastLink.get(tabId);
		if (!redirectedAway({ pending, now: Date.now(), url: tab.url })) return;
		if (!isMissingText(await pageText(tabId))) {
			if (attempt < 2) schedule(tabId, 1000, attempt + 1);
			return;
		}
		({ key, url } = pending);
		activeMissing = true;
	}
	const settings = await readSettings();
	const reason = skipReason({
		settings,
		key,
		tabId,
		now: Date.now(),
		lastSwitchMs: msSinceSwitch(),
		handled,
		unresolved,
	});
	if (reason !== null) return;
	if (isBusy()) {
		if (attempt < BUSY_RETRIES) schedule(tabId, BUSY_RETRY_MS, attempt + 1);
		return;
	}
	if (!settings.confirmed) {
		await updateSettings((s) => ({ ...s, pending: { key, url, at: new Date().toISOString() } }));
		await confirmBanner(tabId);
		return;
	}
	handled.set(tabId, { key, at: Date.now() });
	lastLink.delete(tabId);
	await swapForTab(tabId, url, key, activeMissing).catch(() => undefined);
};

function schedule(tabId, delay = DEBOUNCE_MS, attempt = 0) {
	clearTimeout(timers.get(tabId));
	timers.set(
		tabId,
		setTimeout(() => {
			timers.delete(tabId);
			handleTab(tabId, attempt).catch(() => undefined);
		}, delay),
	);
}

export const startAutoSwap = () => {
	chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
		const key = linkKey(tab.url ?? "");
		if (key !== null) {
			if (change.url) lastLink.set(tabId, { key, url: tab.url, at: Date.now() });
			if (change.url || change.status === "complete") schedule(tabId);
		} else if (change.url && redirectedAway({ pending: lastLink.get(tabId), now: Date.now(), url: tab.url })) {
			schedule(tabId, 800);
		}
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		lastLink.delete(tabId);
		handled.delete(tabId);
		clearTimeout(timers.get(tabId));
		timers.delete(tabId);
	});
};

const summary = async (url) => {
	const settings = await readSettings();
	const key = typeof url === "string" ? linkKey(url) : null;
	return {
		ok: true,
		enabled: settings.enabled,
		confirmed: settings.confirmed,
		pending: settings.pending,
		last: settings.last,
		cacheSize: Object.keys(settings.cache).length,
		link: key === null ? null : { key, optedOut: settings.optOut.includes(key), owner: settings.cache[key] ?? null },
	};
};

export const autoswapHandlers = {
	"autoswap.get": (msg) => summary(msg.url),
	"autoswap.setEnabled": async (msg, _external, tabId) => {
		if (typeof msg.enabled !== "boolean") return failure("invalid_request", "enabled must be true or false");
		await updateSettings((s) => ({ ...s, enabled: msg.enabled, confirmed: true, pending: null }));
		if (msg.enabled && tabId !== undefined) schedule(tabId, 200);
		return summary(null);
	},
	"autoswap.setLinkOptOut": async (msg) => {
		const key = linkKey(msg.url);
		if (key === null || typeof msg.optedOut !== "boolean") return failure("invalid_request", "Needs a claude.ai resource link and optedOut true or false");
		await updateSettings((s) => withOptOut(s, key, msg.optedOut));
		unresolved.delete(key);
		return summary(msg.url);
	},
	"autoswap.forgetLink": async (msg) => {
		const key = linkKey(msg.url);
		if (key === null) return failure("invalid_request", "Needs a claude.ai resource link");
		await updateSettings((s) => withoutOwner(s, key));
		unresolved.delete(key);
		return summary(msg.url);
	},
	"autoswap.clearCache": async () => {
		await updateSettings((s) => ({ ...s, cache: {} }));
		unresolved.clear();
		return summary(null);
	},
};
