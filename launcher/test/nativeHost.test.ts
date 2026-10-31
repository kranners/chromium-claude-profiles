import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createDecoder, createNativeHandler, encodeMessage, runNativeHost, userDataDirFromArgs } from "../src/nativeHost.ts";
import { tempContext } from "./helpers.ts";

const ORIGIN = "chrome-extension://bkgjdpakjigjgdggfcckikppbjjcdkim/";

test("encodeMessage prefixes a little-endian length", () => {
	const encoded = encodeMessage({ type: "ping" });
	const body = Buffer.from('{"type":"ping"}');
	assert.equal(encoded.readUInt32LE(0), body.length);
	assert.deepEqual(encoded.subarray(0, 4), Buffer.from([body.length, 0, 0, 0]));
	assert.deepEqual(encoded.subarray(4), body);
});

test("the decoder joins one message split across three chunks", () => {
	const seen: unknown[] = [];
	const decode = createDecoder((msg) => seen.push(msg));
	const encoded = encodeMessage({ type: "profiles.list", pad: "x".repeat(20) });
	decode(encoded.subarray(0, 2));
	decode(encoded.subarray(2, 10));
	assert.deepEqual(seen, []);
	decode(encoded.subarray(10));
	assert.deepEqual(seen, [{ type: "profiles.list", pad: "x".repeat(20) }]);
});

test("the decoder splits two messages in one chunk", () => {
	const seen: unknown[] = [];
	const decode = createDecoder((msg) => seen.push(msg));
	decode(Buffer.concat([encodeMessage({ n: 1 }), encodeMessage({ n: 2 })]));
	assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
});

const exchange = async (origin: string, messages: unknown[]): Promise<unknown[]> => {
	const input = new PassThrough();
	const output = new PassThrough();
	const replies: unknown[] = [];
	const decode = createDecoder((msg) => replies.push(msg));
	output.on("data", decode);
	const done = runNativeHost(input, output, createNativeHandler(origin, tempContext()));
	for (const message of messages) input.write(encodeMessage(message));
	input.end();
	await done;
	return replies;
};

test("runNativeHost answers ping and keeps add off the native host", async () => {
	assert.deepEqual(await exchange(ORIGIN, [{ type: "ping" }, { type: "profiles.add", name: "a" }]), [
		{ ok: true, version: "0.1.0" },
		{ ok: false, error: { code: "unsupported", message: "profiles.add is not available over the native host" } },
	]);
});

test("a wrong origin gets unauthorized for every message", async () => {
	const replies = await exchange("chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/", [{ type: "ping" }, { type: "profiles.list" }]);
	assert.equal(replies.length, 2);
	for (const reply of replies) assert.equal((reply as { error: { code: string } }).error.code, "unauthorized");
});

test("an oversized response is replaced with internal", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const replies: unknown[] = [];
	output.on("data", createDecoder((msg) => replies.push(msg)));
	const done = runNativeHost(input, output, async () => ({ ok: true, blob: "x".repeat(1_000_001) }));
	input.end(encodeMessage({ type: "ping" }));
	await done;
	assert.deepEqual(replies, [{ ok: false, error: { code: "internal", message: "response too large" } }]);
});

test("userDataDirFromArgs reads the flag up to the next flag", () => {
	assert.equal(
		userDataDirFromArgs("/Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=/a b/profiles/x --no-first-run\n"),
		"/a b/profiles/x",
	);
	assert.equal(userDataDirFromArgs("Chromium --user-data-dir=/p/y"), "/p/y");
	assert.equal(userDataDirFromArgs("Chromium --no-first-run"), null);
});
