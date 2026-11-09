import { CONTENT_TYPES, EXTERNAL_TYPES, NATIVE_TYPES, POPUP_TYPES, failure, isRequest } from "./lib/protocol.js";
import { sendNative } from "./lib/native.js";
import { bridgeConnected, connectBridge } from "./lib/bridge.js";
import { autoswapHandlers, startAutoSwap } from "./lib/autoswap.js";
import {
	cancelRelogin,
	checkAccounts,
	checkForBridge,
	exportLive,
	importAccount,
	listForBridge,
	openAccount,
	openFor,
	expireRelogin,
	forgetAccount,
	listAccounts,
	onCookieChanged,
	saveAccount,
	signInAnother,
	startRelogin,
	switchAccount,
} from "./lib/jars.js";

const CHECK_ALARM = "check-accounts";
const BRIDGE_ALARM = "bridge";

const withoutEmail = ({ email: _email, ...rest }) => rest;

const listForExternal = async () => {
	const result = await listAccounts();
	return { ...result, accounts: result.accounts.map(withoutEmail) };
};

const accountHandlers = {
	"accounts.list": (_msg, external) => (external ? listForExternal() : listAccounts()),
	"accounts.save": (msg) => saveAccount(msg.label),
	"accounts.switch": async (msg, external) => {
		const result = await switchAccount(msg.label);
		return external ? withoutEmail(result) : result;
	},
	"accounts.forget": (msg) => forgetAccount(msg.label),
	"accounts.signIn": () => signInAnother(),
	"accounts.check": () => checkAccounts(),
	"accounts.relogin": () => startRelogin(),
	"accounts.reloginCancel": () => cancelRelogin(),
	"accounts.open": async (msg, external) => {
		const result = await openAccount(msg.label, msg.url ?? null);
		return external ? withoutEmail(result) : result;
	},
	"bridge.status": () => ({ ok: true, connected: bridgeConnected() }),
	...autoswapHandlers,
};

const bridgeHandlers = {
	ping: () => ({ ok: true }),
	"accounts.list": () => listForBridge(),
	"accounts.check": () => checkForBridge(),
	"accounts.open": (msg) => openAccount(msg.label, msg.url ?? null),
	"accounts.openFor": (msg) => openFor(msg.url),
	"accounts.import": (msg) => importAccount(msg.label, msg.cookies),
	"accounts.exportLive": () => exportLive(),
};

export const handleBridge = async (msg) => {
	if (!isRequest(msg) || !Object.hasOwn(bridgeHandlers, msg.type)) return unsupported(msg?.type);
	return bridgeHandlers[msg.type](msg);
};

const startBridge = () => connectBridge(handleBridge);

const unsupported = (type) => failure("unsupported", `Unsupported request type: ${type}`);

const allowedTypes = ({ external, content }) => (content ? CONTENT_TYPES : external ? EXTERNAL_TYPES : POPUP_TYPES);

export const dispatch = async (msg, { external, content = false, tabId }) => {
	if (!isRequest(msg)) return failure("invalid_request", "Request must be an object with a string type");
	if (!allowedTypes({ external, content }).has(msg.type)) return unsupported(msg.type);
	try {
		if (NATIVE_TYPES.has(msg.type)) return await sendNative(msg);
		return await accountHandlers[msg.type](msg, external, tabId);
	} catch (error) {
		return failure("internal", error instanceof Error ? error.message : String(error));
	}
};

globalThis.dispatch = dispatch;

// A content script is our own injected banner: a sender with a tab whose page is not one of the extension's.
const isContentSender = (sender) =>
	sender?.tab !== undefined && typeof sender.url === "string" && !sender.url.startsWith(chrome.runtime.getURL(""));

const respondWith = (external) => (msg, sender, sendResponse) => {
	const content = !external && isContentSender(sender);
	dispatch(msg, { external, content, tabId: content ? sender.tab.id : undefined }).then(sendResponse);
	return true;
};

const keepPopupWarm = async () => {
	if (await chrome.offscreen.hasDocument()) return;
	await chrome.offscreen
		.createDocument({
			url: "warm.html",
			reasons: ["LOCAL_STORAGE"],
			justification: "Keeps the extension process alive so the popup opens without starting a renderer",
		})
		.catch(() => undefined);
};

const scheduleChecks = () => {
	chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 60 });
	chrome.alarms.create(BRIDGE_ALARM, { periodInMinutes: 1 });
};

const onAlarm = async ({ name }) => {
	if (name === BRIDGE_ALARM) return startBridge();
	await expireRelogin();
	if (name === CHECK_ALARM) await checkAccounts();
};

const onBrowserStart = () => {
	keepPopupWarm();
	scheduleChecks();
	startBridge();
};

chrome.runtime.onStartup.addListener(onBrowserStart);
chrome.runtime.onInstalled.addListener(onBrowserStart);
keepPopupWarm();
startBridge();
startAutoSwap();

chrome.alarms.onAlarm.addListener((alarm) => onAlarm(alarm).catch(() => undefined));
chrome.cookies.onChanged.addListener(onCookieChanged);

chrome.runtime.onMessage.addListener(respondWith(false));
chrome.runtime.onMessageExternal.addListener(respondWith(true));
