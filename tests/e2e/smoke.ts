import { execFile } from "node:child_process";
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
	CCP_EXTRA_ARGS: "--headless=new --remote-debugging-port=0 --use-mock-keychain",
};

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

const main = async () => {
	const added = await ccpJson("add", PROFILE, "--email", "smoke@example.com");
	assert.equal(added.ok, true, JSON.stringify(added.error));
	step("add smoke");

	const launched = await ccpJson("launch", PROFILE);
	assert.equal(launched.ok, true, JSON.stringify(launched.error));
	assert.equal(launched.profile.running, true);
	browserPid = launched.profile.pid;
	const userDataDir: string = launched.profile.userDataDir;
	step(`launch smoke (pid ${browserPid}, Claude in Chrome ${launched.claudeInChromeVersion ?? "absent"})`);

	const port = await pollFor("DevToolsActivePort", 15_000, () => {
		const firstLine = readOrNull(join(userDataDir, "DevToolsActivePort"))?.split("\n")[0];
		return firstLine && /^[0-9]+$/.test(firstLine) ? Number(firstLine) : null;
	});
	step(`DevTools on port ${port}`);

	const ourWorker = await pollFor("service worker targets", 15_000, async () => {
		const targets = await listTargets(port);
		const ours = workerTarget(targets, OUR_EXTENSION_ID);
		const claudeReady = launched.claudeInChromeVersion === null || workerTarget(targets, CLAUDE_IN_CHROME_ID) !== undefined;
		return ours && claudeReady ? ours : null;
	});
	assert.equal(ourWorker.url, `chrome-extension://${OUR_EXTENSION_ID}/service-worker.js`);
	step("service worker targets present");

	await pollFor("our service worker to finish loading", 15_000, async () =>
		(await evaluateInWorker(port, `typeof globalThis.dispatch === "function"`)) === true ? true : null,
	);

	const listed = await evaluateInWorker(
		port,
		`chrome.runtime.sendNativeMessage(${JSON.stringify(HOST_NAME)}, {type: "profiles.list"})`,
	);
	assert.equal(listed?.ok, true, JSON.stringify(listed?.error));
	assert.equal(listed.current, PROFILE);
	step("native host profiles.list reports current = smoke");

	const accounts = await evaluateInWorker(port, `dispatch({type: "accounts.list"}, {external: false})`);
	assert.deepEqual(accounts, { ok: true, accounts: [] });
	step("dispatcher accounts.list is empty");

	const pid = lockPid(userDataDir);
	assert.ok(pid !== null, "SingletonLock has no pid");
	process.kill(pid, "SIGTERM");
	await pollFor("Chromium to exit", 5_000, () => (alive(pid) ? null : true));
	const status = await ccpJson("status", PROFILE);
	assert.equal(status.ok, true, JSON.stringify(status.error));
	assert.equal(status.profile.running, false);
	step("status reports running: false after SIGTERM");
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
	for (const pid of new Set([browserPid, lockPid(join(home, "profiles", PROFILE))])) {
		if (pid !== null && alive(pid)) killGroup(pid);
	}
	rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
