export const VERSION = "0.1.0";
export const HOST_NAME = "engineer.cute.claude_profiles";
export const EXTENSION_ID = "bkgjdpakjigjgdggfcckikppbjjcdkim";
export const LABEL_PATTERN = /^[A-Za-z0-9 ._@-]{1,64}$/;

export const NATIVE_TYPES = new Set(["ping", "profiles.list", "profiles.launch"]);
export const EXTERNAL_TYPES = new Set([...NATIVE_TYPES, "accounts.list", "accounts.switch"]);
export const POPUP_TYPES = new Set([...EXTERNAL_TYPES, "accounts.save", "accounts.forget", "accounts.signIn"]);

export const failure = (code, message) => ({ ok: false, error: { code, message } });

export const isRequest = (msg) =>
	typeof msg === "object" && msg !== null && !Array.isArray(msg) && typeof msg.type === "string";

export const isLabel = (label) => typeof label === "string" && LABEL_PATTERN.test(label);
