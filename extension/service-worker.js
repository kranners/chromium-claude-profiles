import { EXTERNAL_TYPES, NATIVE_TYPES, POPUP_TYPES, failure, isRequest } from "./lib/protocol.js";
import { sendNative } from "./lib/native.js";
import { forgetAccount, listAccounts, saveAccount, signInAnother, switchAccount } from "./lib/jars.js";

const accountHandlers = {
	"accounts.list": () => listAccounts(),
	"accounts.save": (msg) => saveAccount(msg.label),
	"accounts.switch": (msg) => switchAccount(msg.label),
	"accounts.forget": (msg) => forgetAccount(msg.label),
	"accounts.signIn": () => signInAnother(),
};

const unsupported = (type) => failure("unsupported", `Unsupported request type: ${type}`);

export const dispatch = async (msg, { external }) => {
	if (!isRequest(msg)) return failure("invalid_request", "Request must be an object with a string type");
	const allowed = external ? EXTERNAL_TYPES : POPUP_TYPES;
	if (!allowed.has(msg.type)) return unsupported(msg.type);
	try {
		if (NATIVE_TYPES.has(msg.type)) return await sendNative(msg);
		return await accountHandlers[msg.type](msg);
	} catch (error) {
		return failure("internal", error instanceof Error ? error.message : String(error));
	}
};

globalThis.dispatch = dispatch;

const respondWith = (external) => (msg, _sender, sendResponse) => {
	dispatch(msg, { external }).then(sendResponse);
	return true;
};

chrome.runtime.onMessage.addListener(respondWith(false));
chrome.runtime.onMessageExternal.addListener(respondWith(true));
