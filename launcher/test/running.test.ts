import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isRunning, parseSingletonLock } from "../src/running.ts";
import { tempDir } from "./helpers.ts";

test("parseSingletonLock splits on the last dash", () => {
	assert.deepEqual(parseSingletonLock("pilot-2353"), { host: "pilot", pid: 2353 });
	assert.deepEqual(parseSingletonLock("my-mac-123"), { host: "my-mac", pid: 123 });
});

test("parseSingletonLock rejects garbage", () => {
	for (const target of ["", "pilot", "pilot-", "-123", "pilot-12a", "pilot-0"]) {
		assert.equal(parseSingletonLock(target), null, target);
	}
});

const lockedDir = (target: string): string => {
	const dir = tempDir();
	symlinkSync(target, join(dir, "SingletonLock"));
	return dir;
};

test("isRunning needs a matching host and a live pid", () => {
	const dir = lockedDir("pilot-4242");
	assert.deepEqual(isRunning(dir, "pilot", () => true), { running: true, pid: 4242 });
	assert.deepEqual(isRunning(dir, "pilot.local", () => true), { running: true, pid: 4242 });
	assert.deepEqual(isRunning(dir, "pilot", () => false), { running: false, pid: null });
	assert.deepEqual(isRunning(dir, "other", () => true), { running: false, pid: null });
});

test("isRunning passes the lock pid to alive", () => {
	const seen: number[] = [];
	isRunning(lockedDir("pilot-77"), "pilot", (pid) => seen.push(pid) > 0);
	assert.deepEqual(seen, [77]);
});

test("a missing lock is not running", () => {
	assert.deepEqual(isRunning(tempDir(), "pilot", () => true), { running: false, pid: null });
});
