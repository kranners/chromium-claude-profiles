import test from "node:test";
import assert from "node:assert/strict";
import { NATIVE_TYPES, POPUP_TYPES } from "../lib/protocol.js";

const listener = { addListener: () => {} };
const resolved = (value) => async () => value;

globalThis.chrome = {
	runtime: {
		id: "extid",
		getURL: (path) => `chrome-extension://extid/${path}`,
		sendNativeMessage: (_host, _msg, reply) => reply({ ok: true, running: false, order: [], skipped: [] }),
		onStartup: listener,
		onInstalled: listener,
		onMessage: listener,
		onMessageExternal: listener,
	},
	storage: { local: { get: resolved({}), set: resolved(undefined), remove: resolved(undefined) }, onChanged: listener },
	cookies: { getAll: resolved([]), remove: resolved(undefined), set: resolved(undefined), onChanged: listener },
	declarativeNetRequest: { updateSessionRules: resolved(undefined) },
	tabs: {
		query: resolved([]),
		reload: resolved(undefined),
		create: async (props) => ({ id: 9, windowId: 1, ...props }),
		update: async (id, props) => ({ id, windowId: 1, ...props }),
		get: async () => null,
		remove: resolved(undefined),
		onUpdated: listener,
		onRemoved: listener,
	},
	windows: { update: resolved({}) },
	offscreen: { hasDocument: resolved(true) },
	alarms: { create: resolved(undefined), clear: resolved(true), onAlarm: listener },
	action: { setBadgeText: resolved(undefined), setBadgeBackgroundColor: resolved(undefined) },
};
globalThis.fetch = async () => ({ status: 401, headers: new Headers(), json: async () => ({}) });

const { accountHandlers, bridgeHandlers, dispatch, handleBridge } = await import("../service-worker.js");

const SAMPLE = { label: "a@example.com", url: "https://claude.ai/new", enabled: false, optedOut: false, cookies: [] };

const UNDEFINED_NAME = /is not defined|is not a function/;

const assertResolves = (type, result) => {
	assert.equal(typeof result, "object", type);
	assert.doesNotMatch(result.ok ? "" : result.error.message, UNDEFINED_NAME, type);
};

test("every popup request type has a handler", () => {
	for (const type of POPUP_TYPES) {
		if (!NATIVE_TYPES.has(type)) assert.equal(typeof accountHandlers[type], "function", type);
	}
});

test("every popup handler calls only functions that exist", async () => {
	for (const type of POPUP_TYPES) {
		if (!NATIVE_TYPES.has(type)) assertResolves(type, await dispatch({ type, ...SAMPLE }, { external: false }));
	}
});

test("every bridge handler calls only functions that exist", async () => {
	for (const type of Object.keys(bridgeHandlers)) {
		assertResolves(type, await handleBridge({ type, ...SAMPLE }).catch((error) => ({ ok: false, error })));
	}
});
