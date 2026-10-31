import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { symlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isBrowserFor, isRunning, parseSingletonLock } from "../src/running.ts";
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

const withProcess = async (args: string[], check: (pid: number) => void): Promise<void> => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], { stdio: "ignore" });
	try {
		check(child.pid as number);
	} finally {
		child.kill();
		await once(child, "exit");
	}
};

test("isBrowserFor needs the pid to run with this user-data-dir", async () => {
	const dir = tempDir();
	await withProcess([`--user-data-dir=${dir}`, "--no-first-run"], (pid) => {
		assert.equal(isBrowserFor(dir, pid), true);
		assert.equal(isBrowserFor(`${dir}x`, pid), false);
	});
	await withProcess([], (pid) => assert.equal(isBrowserFor(dir, pid), false));
});

test("a stale lock whose pid now belongs to another process is not running", async () => {
	await withProcess([], (pid) => {
		const dir = lockedDir(`${hostname()}-${pid}`);
		assert.deepEqual(isRunning(dir), { running: false, pid: null });
	});
});
