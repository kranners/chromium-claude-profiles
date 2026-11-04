import { HOST_NAME, failure } from "./protocol.js";

let port = null;
let connected = false;

export const bridgeConnected = () => connected;

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

export const sendBridge = (msg) => {
	if (!port) return false;
	try {
		port.postMessage(msg);
		return true;
	} catch {
		return false;
	}
};

export const connectBridge = (handle) => {
	if (port || typeof chrome.runtime?.connectNative !== "function") return;
	try {
		port = chrome.runtime.connectNative(HOST_NAME);
	} catch {
		port = null;
		return;
	}
	const current = port;
	current.onMessage.addListener((msg) => {
		if (msg?.type === "bridge.request" && typeof msg.id === "number") {
			Promise.resolve()
				.then(() => handle(msg.request))
				.catch((error) => failure("internal", errorMessage(error)))
				.then((response) => {
					if (port === current) sendBridge({ type: "bridge.reply", id: msg.id, response });
				});
		} else if (msg?.attached === true) {
			connected = true;
		}
	});
	current.onDisconnect.addListener(() => {
		void chrome.runtime.lastError;
		if (port === current) {
			port = null;
			connected = false;
		}
	});
	current.postMessage({ type: "bridge.attach" });
};
