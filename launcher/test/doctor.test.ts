import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diagnose } from "../src/doctor.ts";
import type { DoctorInputs } from "../src/doctor.ts";
import { browserFile, browserOf, chromiumBinary, chromiumDefaultHostsDir, chromiumSupportDir } from "../src/paths.ts";

const ready = (): DoctorInputs => ({
	nodeMajor: 24,
	platform: "darwin",
	browser: "chromium",
	extensionDir: "/x/extension",
	extensionDirExists: true,
	hostManifest: { path: "/h/m.json", exists: true, wrapperExists: true, originOk: true },
	bridgeConnected: true,
	accounts: { count: 2, signedOut: 0 },
});

test("a working install is ready and says how to add another account", () => {
	const result = diagnose(ready());
	assert.equal(result.ready, true);
	assert.ok(result.checks.every((check) => check.ok));
	assert.match(result.next, /sign-in-another/);
});

test("the first failing check decides what to do next", () => {
	assert.match(diagnose({ ...ready(), nodeMajor: 22 }).next, /Node 24/);
	const noHost = diagnose({ ...ready(), hostManifest: { path: "/h/m.json", exists: false, wrapperExists: false, originOk: false }, bridgeConnected: false });
	assert.equal(noHost.ready, false);
	assert.match(noHost.next, /ccp install-host --browser chromium/);
	const notLoaded = diagnose({ ...ready(), bridgeConnected: false, accounts: null });
	assert.equal(notLoaded.ready, false);
	assert.match(notLoaded.next, /Load unpacked.*\/x\/extension/);
});

test("a host manifest that points at a missing wrapper or the wrong extension is not ok", () => {
	assert.equal(diagnose({ ...ready(), hostManifest: { path: "p", exists: true, wrapperExists: false, originOk: true } }).ready, false);
	assert.equal(diagnose({ ...ready(), hostManifest: { path: "p", exists: true, wrapperExists: true, originOk: false } }).ready, false);
});

test("no accounts and signed-out accounts are next steps, not failures", () => {
	const none = diagnose({ ...ready(), accounts: { count: 0, signedOut: 0 } });
	assert.equal(none.ready, true);
	assert.match(none.next, /ccp save/);
	assert.match(diagnose({ ...ready(), accounts: { count: 2, signedOut: 1 } }).next, /signed out/);
});

test("browser and platform pick the native host folder and the binary", () => {
	const env = { HOME: "/home/me", CCP_HOME: "/nonexistent/ccp-home" };
	assert.equal(chromiumDefaultHostsDir({ ...env, CCP_PLATFORM: "darwin" }), "/home/me/Library/Application Support/Chromium/NativeMessagingHosts");
	assert.equal(chromiumSupportDir({ ...env, CCP_PLATFORM: "darwin", CCP_BROWSER: "chrome" }), "/home/me/Library/Application Support/Google/Chrome");
	assert.equal(chromiumSupportDir({ ...env, CCP_PLATFORM: "linux", CCP_BROWSER: "chromium" }), "/home/me/.config/chromium");
	assert.equal(chromiumSupportDir({ ...env, CCP_PLATFORM: "linux", CCP_BROWSER: "chrome" }), "/home/me/.config/google-chrome");
	assert.equal(chromiumBinary({ ...env, CCP_PLATFORM: "darwin", CCP_BROWSER: "chrome" }), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
	assert.equal(chromiumBinary({ ...env, CCP_PLATFORM: "darwin", CCP_CHROMIUM: "/opt/b" }), "/opt/b");
	assert.equal(chromiumBinary({ ...env, CCP_PLATFORM: "linux", CCP_BROWSER: "chromium", PATH: "/nonexistent" }), "chromium");
});

test("the browser install-host saved is used until CCP_BROWSER overrides it", () => {
	const home = mkdtempSync(join(tmpdir(), "ccp-browser-"));
	const env = { HOME: home, CCP_HOME: home };
	assert.equal(browserOf(env), "chromium");
	mkdirSync(home, { recursive: true });
	writeFileSync(browserFile(home), "chrome\n");
	assert.equal(browserOf(env), "chrome");
	assert.equal(browserOf({ ...env, CCP_BROWSER: "brave" }), "brave");
	writeFileSync(browserFile(home), "netscape\n");
	assert.equal(browserOf(env), "chromium");
});
