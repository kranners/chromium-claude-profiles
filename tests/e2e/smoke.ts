import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const OUR_EXTENSION_ID = "bkgjdpakjigjgdggfcckikppbjjcdkim";
const CLAUDE_IN_CHROME_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
const HOST_NAME = "engineer.cute.claude_profiles";
const PROFILE = "smoke";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ccpBin = join(repoRoot, "launcher", "bin", "ccp");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ccp-e2e-")));
const home = join(scratch, "ccp-home");
const fakeUserHome = join(scratch, "user-home");
const realUserHome = process.env.HOME ?? "";

const env: NodeJS.ProcessEnv = {
	...process.env,
	HOME: fakeUserHome,
	CCP_HOME: home,
	CCP_CLAUDE_EXT_SOURCE:
		process.env.CCP_CLAUDE_EXT_SOURCE ??
		join(realUserHome, "Library", "Application Support", "Chromium", "Default", "Extensions", CLAUDE_IN_CHROME_ID),
	CCP_EXTRA_ARGS: `--headless=new --remote-debugging-port=0 --use-mock-keychain ${process.env.CCP_E2E_EXTRA_ARGS ?? ""}`.trim(),
	CCP_NODE: process.env.CCP_NODE ?? process.execPath,
};

const chromium = env.CCP_CHROMIUM ?? "/Applications/Chromium.app/Contents/MacOS/Chromium";
const mainUserDataDir = join(fakeUserHome, "Library", "Application Support", "Chromium");

type CcpRun = { code: number; stdout: string; stderr: string };

const ccp = (...args: string[]): Promise<CcpRun> =>
	new Promise((done) => {
		execFile(ccpBin, args, { env, timeout: 30_000 }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			done({ code, stdout, stderr });
		});
	});

const ccpJson = async (...args: string[]): Promise<any> => {
	const run = await ccp(...args, "--json");
	try {
		return JSON.parse(run.stdout);
	} catch {
		throw new Error(`ccp ${args.join(" ")} printed no JSON (exit ${run.code}): ${run.stderr.trim()}`);
	}
};

const pollFor = async <T>(what: string, timeoutMs: number, probe: () => T | null | Promise<T | null>): Promise<T> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value !== null) return value;
		await delay(100);
	}
	throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
};

const readOrNull = (path: string): string | null => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};

const lockPid = (userDataDir: string): number | null => {
	try {
		const pid = Number(readlinkSync(join(userDataDir, "SingletonLock")).split("-").at(-1));
		return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
};

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

type Target = { type: string; url: string; webSocketDebuggerUrl: string };

const listTargets = async (port: number): Promise<Target[]> => {
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	return (await response.json()) as Target[];
};

const workerTarget = (targets: Target[], extensionId: string): Target | undefined =>
	targets.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`));

const evaluate = (webSocketUrl: string, expression: string): Promise<any> =>
	new Promise((done, failWith) => {
		const socket = new WebSocket(webSocketUrl);
		const timer = setTimeout(() => {
			socket.close();
			failWith(new Error(`Runtime.evaluate timed out: ${expression}`));
		}, 5_000);
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			failWith(new Error(`DevTools socket failed for ${webSocketUrl}`));
		});
		socket.addEventListener("open", () => {
			socket.send(
				JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }),
			);
		});
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data));
			if (message.id !== 1) return;
			clearTimeout(timer);
			socket.close();
			if (message.error) return failWith(new Error(`Runtime.evaluate failed: ${message.error.message}`));
			if (message.result.exceptionDetails) {
				return failWith(new Error(`Runtime.evaluate threw: ${message.result.exceptionDetails.exception?.description}`));
			}
			done(message.result.result.value);
		});
	});

const evaluateInWorker = async (port: number, expression: string): Promise<any> => {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		const worker = workerTarget(await listTargets(port), OUR_EXTENSION_ID);
		if (!worker) {
			await delay(500);
			continue;
		}
		try {
			return await evaluate(worker.webSocketDebuggerUrl, expression);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError ?? new Error(`our service worker is gone: ${expression}`);
};

const step = (text: string) => process.stdout.write(`ok - ${text}\n`);

let browserPid: number | null = null;

const startMainBrowser = (): number => {
	const child = spawn(
		chromium,
		[
			`--user-data-dir=${mainUserDataDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			`--load-extension=${join(repoRoot, "extension")}`,
			...(env.CCP_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean),
		],
		{ detached: true, stdio: "ignore", env },
	);
	child.on("error", (error) => process.stderr.write(`could not start ${chromium}: ${error.message}\n`));
	child.unref();
	if (child.pid === undefined) throw new Error(`could not start ${chromium}`);
	return child.pid;
};

const main = async () => {
	const added = await ccpJson("add", PROFILE, "--email", "smoke@example.com");
	assert.equal(added.ok, true, JSON.stringify(added.error));
	step("add an old per-account profile");

	const installed = await ccp("install-host", "--chromium-default");
	assert.equal(installed.code, 0, installed.stderr);
	browserPid = startMainBrowser();
	step(`main Chromium started with Claude Profiles (pid ${browserPid})`);

	const port = await pollFor("DevToolsActivePort", 15_000, () => {
		const firstLine = readOrNull(join(mainUserDataDir, "DevToolsActivePort"))?.split("\n")[0];
		return firstLine && /^[0-9]+$/.test(firstLine) ? Number(firstLine) : null;
	});
	const ourWorker = await pollFor("our service worker", 15_000, async () => workerTarget(await listTargets(port), OUR_EXTENSION_ID) ?? null);
	assert.equal(ourWorker.url, `chrome-extension://${OUR_EXTENSION_ID}/service-worker.js`);
	step("service worker target present");

	await pollFor("our service worker to finish loading", 15_000, async () =>
		(await evaluateInWorker(port, `typeof globalThis.dispatch === "function"`)) === true ? true : null,
	);
	const listed = await evaluateInWorker(port, `chrome.runtime.sendNativeMessage(${JSON.stringify(HOST_NAME)}, {type: "profiles.list"})`);
	assert.equal(listed?.ok, true, JSON.stringify(listed?.error));
	assert.equal(listed.current, null);
	step("native host sees the main browser (current = null)");

	const connected = await pollFor("ccp to reach the main browser", 20_000, async () => {
		const result = await ccpJson("list");
		return result.ok && result.browser.connected ? result : null;
	});
	assert.deepEqual(connected.accounts, []);
	assert.deepEqual(connected.profiles, []);
	assert.deepEqual(connected.legacyProfiles, [PROFILE]);
	assert.equal(connected.schemaVersion, 1);
	step("ccp list reaches the main browser over the bridge");

	const missing = await ccp("launch", "nobody", "--json");
	assert.equal(missing.code, 1);
	assert.equal(JSON.parse(missing.stdout).error.code, "not_found");
	const old = await ccp("launch", PROFILE, "--json");
	assert.equal(JSON.parse(old.stdout).error.code, "not_found");
	assert.equal(lockPid(join(home, "profiles", PROFILE)), null, "launch started an old profile");
	step("launch opens accounts in the main browser only, never an old profile");

	const badLink = await ccp("open-for", "https://example.com/", "--json");
	assert.equal(JSON.parse(badLink.stdout).error.code, "invalid_request");
	step("open-for takes claude.ai links only");

	const migrated = await ccpJson("migrate");
	assert.equal(migrated.ok, true, JSON.stringify(migrated.error));
	assert.deepEqual(
		migrated.profiles.map((row: { profile: string }) => row.profile),
		[PROFILE],
	);
	assert.ok(["signed-out", "unreachable"].includes(migrated.profiles[0].outcome), JSON.stringify(migrated.profiles[0]));
	assert.match(migrated.profiles[0].reason ?? "", /claude\.ai|signed in|check the session/i);
	await pollFor("the old profile migrate started to stop again", 10_000, () => {
		const oldPid = lockPid(join(home, "profiles", PROFILE));
		return oldPid === null || !alive(oldPid) ? true : null;
	});
	step(`migrate read the old profile headless and stopped it again (${migrated.profiles[0].outcome}: ${migrated.profiles[0].reason})`);

	const accounts = await evaluateInWorker(port, `dispatch({type: "accounts.list"}, {external: false})`);
	assert.deepEqual(accounts, { ok: true, accounts: [] });
	step("dispatcher accounts.list is empty");

	const pid = lockPid(mainUserDataDir) ?? browserPid;
	process.kill(pid, "SIGTERM");
	await pollFor("Chromium to exit", 10_000, () => (alive(pid) ? null : true));
	const after = await ccpJson("list");
	assert.equal(after.browser.connected, false);
	step("list reports the browser disconnected once Chromium quits");
};

const killGroup = (pid: number) => {
	for (const target of [-pid, pid]) {
		try {
			process.kill(target, "SIGKILL");
		} catch {}
	}
};

let failed = false;
try {
	await main();
	process.stdout.write("smoke passed\n");
} catch (error) {
	failed = true;
	process.stderr.write(`not ok - ${(error as Error).message}\n`);
} finally {
	for (const pid of new Set([browserPid, lockPid(mainUserDataDir), lockPid(join(home, "profiles", PROFILE))])) {
		if (pid !== null && alive(pid)) killGroup(pid);
	}
	rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
