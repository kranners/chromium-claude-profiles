import assert from "node:assert/strict";
import { test } from "node:test";
import { handle, handleNative, NATIVE_HOST_TYPES } from "../src/protocol.ts";
import { tempContext } from "./helpers.ts";

test("ping reports the version", async () => {
	assert.deepEqual(await handle({ type: "ping" }, tempContext()), { ok: true, version: "0.1.0" });
});

test("an unknown type is unsupported", async () => {
	const result = await handle({ type: "profiles.explode" }, tempContext());
	assert.equal(!result.ok && result.error.code, "unsupported");
});

test("a malformed request is invalid", async () => {
	for (const req of [null, "ping", [], { name: "a" }]) {
		const result = await handle(req, tempContext());
		assert.equal(!result.ok && result.error.code, "invalid_request");
	}
});

test("the native-host allowlist rejects add and remove", async () => {
	assert.deepEqual(NATIVE_HOST_TYPES, ["ping", "profiles.list", "profiles.status", "profiles.launch", "relogin.start", "relogin.status", "relogin.stop"]);
	const ctx = tempContext();
	for (const type of ["profiles.add", "profiles.remove", "profiles.env"]) {
		const result = await handleNative({ type, name: "a" }, ctx);
		assert.equal(!result.ok && result.error.code, "unsupported", type);
	}
	assert.equal((await handle({ type: "profiles.list" }, ctx)).ok, true);
});

test("profiles.list reports current from the context", async () => {
	const ctx = { ...tempContext(), current: "a" };
	const result = await handleNative({ type: "profiles.list" }, ctx);
	assert.equal((result as { current: string }).current, "a");
});
