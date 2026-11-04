import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildLaunchArgs, launchProfile } from "../src/chromium.ts";
import { hostsDir, userDataDir } from "../src/paths.ts";
import type { Profile } from "../src/protocol.ts";
import { handle } from "../src/protocol.ts";
import { isRunning } from "../src/running.ts";
import { tempContext, tempDir } from "./helpers.ts";

const base = [
	"--user-data-dir=/p/a",
	"--profile-directory=Default",
	"--no-first-run",
	"--no-default-browser-check",
	"--load-extension=/v/cic,/r/extension",
];

test("buildLaunchArgs without url or extra args", () => {
	assert.deepEqual(buildLaunchArgs({ userDataDir: "/p/a", extensionDirs: ["/v/cic", "/r/extension"], url: null, extraArgs: [] }), base);
});

test("buildLaunchArgs with url and extra args", () => {
	assert.deepEqual(
		buildLaunchArgs({
			userDataDir: "/p/a",
			extensionDirs: ["/v/cic", "/r/extension"],
			url: "https://claude.ai/",
			extraArgs: ["--headless=new", "--remote-debugging-port=0"],
		}),
		[...base, "--headless=new", "--remote-debugging-port=0", "https://claude.ai/"],
	);
});

test("launch rejects urls that are flags or not http(s)", async () => {
	const ctx = tempContext();
	await handle({ type: "profiles.add", name: "a" }, ctx);
	for (const url of ["--foo", "file:///etc/passwd", "javascript:alert(1)", "not a url", 5]) {
		const result = await handle({ type: "profiles.launch", name: "a", url }, ctx);
		assert.equal(!result.ok && result.error.code, "invalid_request", String(url));
	}
});

const added = async (ctx: ReturnType<typeof tempContext>, name: string): Promise<Profile> =>
	((await handle({ type: "profiles.add", name }, ctx)) as unknown as { profile: Profile }).profile;

test("an old profile's launch reports a missing Chromium binary", async () => {
	const ctx = tempContext();
	const result = await launchProfile(ctx.home, await added(ctx, "a"), null, ctx.env);
	assert.equal(!result.ok && result.error.code, "chromium_not_found");
});

test("launch never starts an old profile: with no main browser it reports Chromium missing", async () => {
	const ctx = tempContext();
	await added(ctx, "a");
	const result = await handle({ type: "profiles.launch", name: "a" }, ctx);
	assert.equal(!result.ok && result.error.code, "chromium_not_found");
	assert.equal(isRunning(userDataDir(ctx.home, "a")).running, false);
});

test("an old profile's launch vendors Claude in Chrome, writes host manifests and waits for the lock", async () => {
	const root = tempDir();
	const source = join(root, "source");
	mkdirSync(join(source, "1.0.102_0"), { recursive: true });
	writeFileSync(join(source, "1.0.102_0", "manifest.json"), JSON.stringify({ version: "1.0.102" }));
	const argsLog = join(root, "args");
	const fakeChromium = join(root, "chromium");
	writeFileSync(
		fakeChromium,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$@" > '${argsLog}'`,
			'for arg in "$@"; do case $arg in --user-data-dir=*) udd=${arg#--user-data-dir=} ;; esac; done',
			'ln -s "$(hostname)-$$" "$udd/SingletonLock"',
			"while :; do sleep 1; done",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	const fakeHostsDir = join(root, "user", "Library", "Application Support", "Chromium", "NativeMessagingHosts");
	mkdirSync(fakeHostsDir, { recursive: true });
	writeFileSync(join(fakeHostsDir, "com.anthropic.claude_code_browser_extension.json"), '{"name":"fake"}\n');
	const ctx = tempContext({
		HOME: join(root, "user"),
		CCP_CHROMIUM: fakeChromium,
		CCP_CLAUDE_EXT_SOURCE: source,
		CCP_EXTENSION_DIR: "/r/extension",
		CCP_EXTRA_ARGS: " --headless=new  --mute-audio ",
	});
	const result = await launchProfile(ctx.home, await added(ctx, "a"), "https://claude.ai/", ctx.env);
	const pid = isRunning(userDataDir(ctx.home, "a")).pid;
	try {
		assert.equal(result.ok, true);
		const launched = result as unknown as { profile: { running: boolean; pid: number }; alreadyRunning: boolean; claudeInChromeVersion: string };
		assert.equal(launched.profile.running, true);
		assert.equal(launched.alreadyRunning, false);
		assert.equal(launched.claudeInChromeVersion, "1.0.102");
		const vendored = join(ctx.home, "vendor", "claude-in-chrome", "1.0.102_0");
		assert.ok(existsSync(join(vendored, "manifest.json")));
		assert.deepEqual(readFileSync(argsLog, "utf8").trim().split("\n"), [
			`--user-data-dir=${userDataDir(ctx.home, "a")}`,
			"--profile-directory=Default",
			"--no-first-run",
			"--no-default-browser-check",
			`--load-extension=${vendored},/r/extension`,
			"--headless=new",
			"--mute-audio",
			"https://claude.ai/",
		]);
		assert.equal(readFileSync(join(hostsDir(ctx.home, "a"), "com.anthropic.claude_code_browser_extension.json"), "utf8"), '{"name":"fake"}\n');
		const running = await handle({ type: "profiles.remove", name: "a" }, ctx);
		assert.equal(!running.ok && running.error.code, "running");
	} finally {
		if (pid) process.kill(pid, "SIGTERM");
	}
});
