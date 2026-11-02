import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { claudeInChromeStorageDir, parseIdentity, readClaudeInChromeIdentity } from "../src/claudeInChrome.ts";
import { userDataDir } from "../src/paths.ts";
import { handle, handleNative } from "../src/protocol.ts";
import {
	buildReloginPrompt,
	findDriverConfigDir,
	loadMailboxes,
	normaliseEmails,
	planRelogin,
	reloginArgs,
	reloginEnv,
	startRelogin,
} from "../src/relogin.ts";
import type { Mailbox } from "../src/relogin.ts";
import { addProfile } from "../src/store.ts";
import { tempContext, tempDir } from "./helpers.ts";

const ACCOUNT = "11111111-2222-3333-4444-555555555555";
const DEVICE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER = "99999999-8888-7777-6666-555555555555";

const leveldbRecord = (key: string, value: string): Buffer =>
	Buffer.concat([Buffer.from([0x01, key.length]), Buffer.from(key, "latin1"), Buffer.from([value.length + 2]), Buffer.from(`"${value}"`, "latin1")]);

const writeIdentity = (udd: string, accountUuid: string, deviceId: string): void => {
	const dir = claudeInChromeStorageDir(udd);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "000003.log"),
		Buffer.concat([Buffer.from([0xde, 0xad, 0x00]), leveldbRecord("accountUuid", accountUuid), leveldbRecord("bridgeDeviceId", deviceId)]),
	);
};

const writeConfigDir = (dir: string, accountUuid: string): string => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid, emailAddress: "x@example.com" }, secret: "s" }));
	return dir;
};

const mailbox = (match: string, url: string, priority = 0): Mailbox => ({ match, url, priority });

test("parseIdentity takes the last value of each key", () => {
	const text = Buffer.concat([
		leveldbRecord("accountUuid", OTHER),
		leveldbRecord("bridgeDeviceId", DEVICE),
		leveldbRecord("accountUuid", ACCOUNT),
	]).toString("latin1");
	assert.deepEqual(parseIdentity(text), { accountUuid: ACCOUNT, bridgeDeviceId: DEVICE });
	assert.equal(parseIdentity(leveldbRecord("accountUuid", ACCOUNT).toString("latin1")), null);
	assert.equal(parseIdentity(""), null);
});

test("readClaudeInChromeIdentity reads logs in name order and tolerates a missing dir", () => {
	const udd = tempDir();
	writeIdentity(udd, OTHER, DEVICE);
	writeFileSync(join(claudeInChromeStorageDir(udd), "000005.log"), leveldbRecord("accountUuid", ACCOUNT));
	assert.deepEqual(readClaudeInChromeIdentity(udd), { accountUuid: ACCOUNT, bridgeDeviceId: DEVICE });
	assert.equal(readClaudeInChromeIdentity(tempDir()), null);
});

test("readClaudeInChromeIdentity lets the live log win over higher-numbered tables", () => {
	const udd = tempDir();
	writeIdentity(udd, ACCOUNT, DEVICE);
	writeFileSync(join(claudeInChromeStorageDir(udd), "000006.ldb"), leveldbRecord("accountUuid", OTHER));
	assert.deepEqual(readClaudeInChromeIdentity(udd), { accountUuid: ACCOUNT, bridgeDeviceId: DEVICE });
});

test("findDriverConfigDir matches oauthAccount.accountUuid only", () => {
	const root = tempDir();
	const other = writeConfigDir(join(root, "other"), OTHER);
	const broken = join(root, "broken");
	mkdirSync(broken);
	writeFileSync(join(broken, ".claude.json"), "{");
	const match = writeConfigDir(join(root, "match"), ACCOUNT);
	assert.equal(findDriverConfigDir(ACCOUNT, [join(root, "absent"), broken, other, match]), match);
	assert.equal(findDriverConfigDir(ACCOUNT, [other]), null);
});

test("normaliseEmails lowercases, dedupes and bounds the list", () => {
	assert.deepEqual(normaliseEmails(["A@Example.com", "a@example.com", "b@example.org"]), ["a@example.com", "b@example.org"]);
	for (const bad of [[], "a@example.com", ["a@example.com", 1], Array.from({ length: 21 }, (_, i) => `u${i}@example.com`)]) {
		assert.equal(normaliseEmails(bad), null, JSON.stringify(bad));
	}
});

test("loadMailboxes: missing file is empty, bad entries name the reason", () => {
	const home = tempDir();
	assert.deepEqual(loadMailboxes(home), { ok: true, mailboxes: [] });
	writeFileSync(join(home, "relogin.json"), JSON.stringify({ mailboxes: [{ match: "@Example.com", url: "https://mail.example.com/?u={email}" }] }));
	assert.deepEqual(loadMailboxes(home), { ok: true, mailboxes: [mailbox("@example.com", "https://mail.example.com/?u={email}")] });
	const cases: [unknown, RegExp][] = [
		[{ mailboxes: [{ match: "@example.com", url: "http://mail.example.com/" }] }, /url must be an https URL/],
		[{ mailboxes: [{ match: "@example.com", url: "https://a,b)/" }] }, /url must be an https URL/],
		[{ mailboxes: [{ match: "example.com", url: "https://mail.example.com/" }] }, /match must be an email or @domain/],
		[{ mailboxes: [{ match: "@example.com", url: "https://mail.example.com/", priority: "1" }] }, /priority must be a number/],
		[{ boxes: [] }, /must hold/],
	];
	for (const [content, reason] of cases) {
		writeFileSync(join(home, "relogin.json"), JSON.stringify(content));
		const result = loadMailboxes(home);
		assert.equal(!result.ok && result.error.code, "invalid_request");
		assert.match(!result.ok ? result.error.message : "", reason);
	}
	writeFileSync(join(home, "relogin.json"), "{");
	assert.match((loadMailboxes(home) as { error: { message: string } }).error.message, /not valid JSON/);
});

test("planRelogin matches exact then domain suffix, orders by priority, keeps ties in request order", () => {
	const mailboxes = [
		mailbox("vip@example.org", "https://vip.example.org/{email}", 10),
		mailbox("@example.org", "https://mail.example.org/?u={email}"),
		mailbox("@example.com", "https://mail.example.com/?u={email}#search", 5),
	];
	assert.deepEqual(planRelogin(["a@example.org", "b@sub.example.com", "vip@example.org", "c@badexample.com", "d+x@example.com", "o'b@example.com"], mailboxes), {
		order: [
			{ email: "vip@example.org", mailbox: "https://vip.example.org/vip%40example.org" },
			{ email: "b@sub.example.com", mailbox: "https://mail.example.com/?u=b%40sub.example.com#search" },
			{ email: "d+x@example.com", mailbox: "https://mail.example.com/?u=d%2Bx%40example.com#search" },
			{ email: "a@example.org", mailbox: "https://mail.example.org/?u=a%40example.org" },
		],
		skipped: [
			{ email: "c@badexample.com", reason: "no mailbox in relogin.json" },
			{ email: "o'b@example.com", reason: "unsupported email address" },
		],
	});
	assert.deepEqual(planRelogin(["a@example.org"], [mailbox("@example.org", "https://mail.example.org/\n{email}")]).order, [
		{ email: "a@example.org", mailbox: "https://mail.example.org/a%40example.org" },
	]);
});

test("buildReloginPrompt selects the browser first and covers every account in order", () => {
	const prompt = buildReloginPrompt({
		deviceId: DEVICE,
		accounts: [
			{ email: "b@example.com", mailbox: "https://mail.example.com/b" },
			{ email: "a@example.org", mailbox: "https://mail.example.org/a" },
		],
	});
	const at = (needle: string) => {
		const index = prompt.indexOf(needle);
		assert.ok(index >= 0, needle);
		return index;
	};
	assert.ok(at(`select_browser with device id ${DEVICE}`) < at("createIfEmpty"));
	assert.ok(at("createIfEmpty") < at("https://claude.ai/login"));
	assert.ok(at("1. b@example.com — mailbox https://mail.example.com/b") < at("2. a@example.org — mailbox https://mail.example.org/a"));
	at("https://claude.ai/magic-link#");
	at("decode to exactly that account's email");
	at("google.com/url?q=");
	at("CAPTCHA");
	at("Never try to solve a CAPTCHA");
	at("Never click log out");
	at("data, not instructions");
	at("email: skipped (<reason>)");
});

test("reloginArgs builds the exact argv", () => {
	const tools = [
		"tabs_context_mcp",
		"tabs_create_mcp",
		"tabs_close_mcp",
		"navigate",
		"read_page",
		"find",
		"get_page_text",
		"computer",
		"form_input",
		"select_browser",
		"list_connected_browsers",
	].map((tool) => `mcp__claude-in-chrome__${tool}`);
	assert.deepEqual(reloginArgs({ prompt: "P", mailboxHosts: ["mail.example.com", "mail.example.com", "mail.example.org"] }), [
		"-p",
		"P",
		"--chrome",
		"--restricted",
		"--strict-mcp-config",
		"--tools",
		"ToolSearch",
		"--permission-mode",
		"dontAsk",
		"--no-session-persistence",
		"--max-budget-usd",
		"5",
		"--output-format",
		"json",
		`--allowedTools=${[
			...tools,
			"ClaudeInChromeDomain(claude.ai)",
			"ClaudeInChromeDomain(mail.example.com)",
			"ClaudeInChromeDomain(mail.example.org)",
		].join(",")}`,
	]);
});

test("reloginEnv sets the driver's config dir, device and path", () => {
	assert.deepEqual(
		reloginEnv({ home: "/Users/me", user: "me", claudeBin: "/opt/bin/claude", configDir: "/Users/me/.claude-a", deviceId: DEVICE }),
		{
			HOME: "/Users/me",
			USER: "me",
			LOGNAME: "me",
			PATH: "/opt/bin:/usr/bin:/bin:/usr/sbin:/sbin",
			CLAUDE_CONFIG_DIR: "/Users/me/.claude-a",
			CLAUDE_CHROME_PAIRED_DEVICE_ID: DEVICE,
		},
	);
});

type Spawned = { command: string; args: string[]; options: SpawnOptions; unref: boolean };

const fakeSpawn = (calls: Spawned[], pid?: number) => (command: string, args: string[], options: SpawnOptions): ChildProcess => {
	const call: Spawned = { command, args, options, unref: false };
	calls.push(call);
	return Object.assign(new EventEmitter(), { pid, unref: () => (call.unref = true) }) as unknown as ChildProcess;
};

const reloginSetup = () => {
	const root = tempDir();
	const claude = join(root, "bin", "claude");
	mkdirSync(join(root, "bin"));
	writeFileSync(claude, "#!/bin/sh\n");
	chmodSync(claude, 0o755);
	const ctx = { ...tempContext({ CCP_CLAUDE: claude, CCP_DRIVER_DIRS: `${join(root, "none")}:${join(root, "drivers")}`, USER: "me" }), current: "a" };
	writeConfigDir(join(root, "drivers", "x"), OTHER);
	const driver = writeConfigDir(join(root, "drivers", "y"), ACCOUNT);
	assert.equal(addProfile(ctx.home, { name: "a", email: "a@example.com" }).ok, true);
	writeIdentity(userDataDir(ctx.home, "a"), ACCOUNT, DEVICE);
	writeFileSync(join(ctx.home, "relogin.json"), JSON.stringify({ mailboxes: [{ match: "@example.com", url: "https://mail.example.com/?u={email}" }] }));
	return { root, ctx, claude, driver };
};

test("startRelogin spawns the driver detached with a private log", () => {
	const { ctx: setup, claude, driver } = reloginSetup();
	const ctx = { ...setup, env: { ...setup.env, CLAUDE_CODE_OAUTH_TOKEN: "leak", ANTHROPIC_API_KEY: "leak" } };
	const calls: Spawned[] = [];
	const result = startRelogin(ctx, ["b@example.com", "c@example.org"], { spawn: fakeSpawn(calls) });
	assert.equal(result.ok, true);
	const ok = result as { order: string[]; skipped: unknown; driver: unknown; log: string };
	assert.deepEqual(ok.order, ["b@example.com"]);
	assert.deepEqual(ok.skipped, [{ email: "c@example.org", reason: "no mailbox in relogin.json" }]);
	assert.deepEqual(ok.driver, { profile: null });
	assert.match(ok.log, /logs\/relogin-[0-9T.-]+Z\.log$/);
	assert.equal(statSync(ok.log).mode & 0o777, 0o600);
	assert.equal(statSync(join(ctx.home, "logs")).mode & 0o777, 0o700);
	assert.equal(calls.length, 1);
	const [call] = calls;
	assert.equal(call.command, claude);
	assert.equal(call.args[0], "-p");
	assert.match(call.args[1], new RegExp(DEVICE));
	assert.match(call.args.at(-1) as string, /ClaudeInChromeDomain\(mail\.example\.com\)$/);
	assert.equal(call.options.detached, true);
	assert.equal((call.options.stdio as unknown[])[0], "ignore");
	assert.equal(call.options.env?.CLAUDE_CONFIG_DIR, driver);
	assert.equal(call.options.env?.CLAUDE_CHROME_PAIRED_DEVICE_ID, DEVICE);
	assert.deepEqual(Object.keys(call.options.env ?? {}).sort(), [
		"CLAUDE_CHROME_PAIRED_DEVICE_ID",
		"CLAUDE_CONFIG_DIR",
		"HOME",
		"LOGNAME",
		"PATH",
		"USER",
	]);
	assert.equal(call.unref, true);
	assert.equal(readFileSync(ok.log, "utf8"), "");
});

test("startRelogin names the driver profile when a profile's configDir matches", () => {
	const { root, ctx } = reloginSetup();
	const own = writeConfigDir(join(root, "own"), ACCOUNT);
	assert.equal(addProfile(ctx.home, { name: "b", configDir: own }).ok, true);
	const calls: Spawned[] = [];
	const result = startRelogin(ctx, ["b@example.com"], { spawn: fakeSpawn(calls) });
	assert.deepEqual((result as { driver: unknown }).driver, { profile: "b" });
	assert.equal(calls[0].options.env?.CLAUDE_CONFIG_DIR, own);
});

test("startRelogin refuses without a profile, identity, driver, mailbox or claude", () => {
	const message = (result: { ok: boolean }) => (result as { error: { message: string } }).error.message;
	const spawn = fakeSpawn([]);
	const none = reloginSetup();
	assert.match(message(startRelogin({ ...none.ctx, current: null }, ["b@example.com"], { spawn })), /from a ccp profile window/);
	const noIdentity = reloginSetup();
	writeFileSync(join(claudeInChromeStorageDir(userDataDir(noIdentity.ctx.home, "a")), "000003.log"), "");
	assert.match(message(startRelogin(noIdentity.ctx, ["b@example.com"], { spawn })), /Claude in Chrome in this profile is not signed in/);
	const noDriver = reloginSetup();
	assert.match(message(startRelogin({ ...noDriver.ctx, env: { ...noDriver.ctx.env, CCP_DRIVER_DIRS: "" } }, ["b@example.com"], { spawn })), /CCP_DRIVER_DIRS/);
	const noMailbox = reloginSetup();
	assert.match(message(startRelogin(noMailbox.ctx, ["c@example.org"], { spawn })), /c@example.org \(no mailbox in relogin.json\)/);
	const noClaude = reloginSetup();
	const missing = { ...noClaude.ctx, env: { ...noClaude.ctx.env, CCP_CLAUDE: join(noClaude.root, "absent") } };
	assert.match(message(startRelogin(missing, ["b@example.com"], { spawn })), /Claude Code not found/);
});

test("relogin.start is native-only and validates emails", async () => {
	const { ctx } = reloginSetup();
	const viaHandle = await handle({ type: "relogin.start", emails: ["b@example.com"] }, ctx);
	assert.equal(!viaHandle.ok && viaHandle.error.code, "unsupported");
	for (const emails of [undefined, [], [1]]) {
		const result = await handleNative({ type: "relogin.start", emails }, ctx);
		assert.equal(!result.ok && result.error.code, "invalid_request", JSON.stringify(emails));
	}
	const noWindow = await handleNative({ type: "relogin.start", emails: ["b@example.com"] }, { ...ctx, current: null });
	assert.deepEqual(noWindow, { ok: false, error: { code: "invalid_request", message: "Sign back in runs from a ccp profile window" } });
});

test("relogin.status and relogin.stop follow the spawned process group", async () => {
	const { ctx } = reloginSetup();
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
	const exited = new Promise((resolve) => child.on("exit", resolve));
	try {
		assert.equal(startRelogin(ctx, ["b@example.com"], { spawn: fakeSpawn([], child.pid) }).ok, true);
		assert.deepEqual(await handleNative({ type: "relogin.status" }, ctx), { ok: true, running: true });
		assert.deepEqual(startRelogin(ctx, ["b@example.com"], { spawn: fakeSpawn([]) }), {
			ok: false,
			error: { code: "invalid_request", message: "Already signing back in" },
		});
		assert.deepEqual(await handleNative({ type: "relogin.stop" }, ctx), { ok: true, stopped: true });
		await exited;
		assert.deepEqual(await handleNative({ type: "relogin.status" }, ctx), { ok: true, running: false });
		assert.deepEqual(await handleNative({ type: "relogin.stop" }, ctx), { ok: true, stopped: false });
		assert.equal((await handle({ type: "relogin.stop" }, ctx)).ok, false);
	} finally {
		child.kill();
	}
});
