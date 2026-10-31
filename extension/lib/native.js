import { HOST_NAME, failure } from "./protocol.js";

const hostUnavailable = () => failure("native_host_unavailable", "Run: ccp install-host");

export const sendNative = (msg) =>
	new Promise((resolve) => {
		chrome.runtime.sendNativeMessage(HOST_NAME, msg, (response) => {
			if (chrome.runtime.lastError || response === undefined) {
				resolve(hostUnavailable());
				return;
			}
			resolve(response);
		});
	});
