import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { repoRoot } from "../src/paths.ts";
import { tempDir } from "./helpers.ts";

const SCRIPT = join(repoRoot, "scripts", "pilot-migrate.sh");
const EXT_ID = "bkgjdpakjigjgdggfcckikppbjjcdkim";

// A stand-in for launcher/bin/ccp: logs each call and answers from files the test writes.
const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$CCP_TEST_LOG"
case "$1 $2" in
	"list --json"|"status --json") cat "$CCP_TEST_DIR/list.json" ;;
	"migrate --json") cat "$CCP_TEST_DIR/migrate.json" ;;
	"install-host --chromium-default") echo "installed somewhere" ;;
	*) echo "stub $*" ;;
esac
`;

const git = (cwd: string, ...args: string[]) => {
	const run = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
	assert.equal(run.status, 0, run.stderr);
	return run.stdout.trim();
};

const children: ChildProcess[] = [];
after(() => children.forEach((child) => child.kill("SIGKILL")));

// A process whose args look like a browser on that user-data-dir, with the SingletonLock pointing at it.
const fakeBrowser = (userDataDir: string | null, lockDir: string): ChildProcess => {
	const argv0 = userDataDir === null ? "Chromium" : `Chromium --user-data-dir=${userDataDir}`;
	const child = spawn("bash", ["-c", `exec -a "${argv0}" sleep 60`], { stdio: "ignore" });
	children.push(child);
	mkdirSync(lockDir, { recursive: true });
	symlinkSync(`${hostname()}-${child.pid}`, join(lockDir, "SingletonLock"));
	return child;
};

const alive = (child: ChildProcess) => {
	try {
		process.kill(child.pid!, 0);
		return child.exitCode === null && child.signalCode === null;
	} catch {
		return false;
	}
};

const setup = ({ extension = true, connected = true, outcome = "imported" } = {}) => {
	const root = tempDir();
	const home = join(root, "user");
	const origin = join(root, "origin.git");
	const repo = join(home, "workspace", "chromium-claude-profiles");
	const ccpHome = join(home, ".config", "chromium-claude-profiles");
	const support = join(home, "Library", "Application Support", "Chromium");
	mkdirSync(join(home, "workspace"), { recursive: true });
	spawnSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
	const seed = join(root, "seed");
	mkdirSync(join(seed, "launcher", "bin"), { recursive: true });
	git(seed, "init", "--quiet", "-b", "main");
	writeFileSync(join(seed, "launcher", "bin", "ccp"), STUB);
	chmodSync(join(seed, "launcher", "bin", "ccp"), 0o755);
	git(seed, "add", ".");
	git(seed, "commit", "--quiet", "-m", "old");
	git(seed, "remote", "add", "origin", origin);
	git(seed, "push", "--quiet", "origin", "main");
	git(join(home, "workspace"), "clone", "--quiet", origin, repo);
	writeFileSync(join(seed, "NEW"), "new\n");
	git(seed, "add", ".");
	git(seed, "commit", "--quiet", "-m", "new");
	git(seed, "push", "--quiet", "origin", "main");
	const newHead = git(seed, "rev-parse", "HEAD");

	mkdirSync(join(support, "Default"), { recursive: true });
	writeFileSync(join(support, "Default", "Secure Preferences"), extension ? `{"extensions":{"settings":{"${EXT_ID}":{}}}}` : "{}");
	const main = fakeBrowser(null, support);
	const work = join(ccpHome, "profiles", "work");
	const stopped = join(ccpHome, "profiles", "ap4");
	mkdirSync(stopped, { recursive: true });
	const workBrowser = fakeBrowser(work, work);
	writeFileSync(join(ccpHome, "profiles.json"), "{}");
	const testDir = join(root, "answers");
	mkdirSync(testDir);
	writeFileSync(
		join(testDir, "list.json"),
		JSON.stringify({ ok: true, browser: { connected }, accounts: [{ name: "work", email: "ap@example.com", state: "signed-out" }] }),
	);
	writeFileSync(
		join(testDir, "migrate.json"),
		JSON.stringify({ ok: true, profiles: [{ profile: "work", email: "ap@example.com", outcome }, { profile: "ap4", email: null, outcome: "imported" }] }),
	);
	const log = join(root, "ccp.log");
	const run = (...args: string[]) =>
		spawnSync("bash", [SCRIPT, ...args], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: home, CCP_NODE: process.execPath, CCP_TEST_DIR: testDir, CCP_TEST_LOG: log, CCP_BRIDGE_WAIT: "0", CCP_MIGRATE_TEST: "1" },
		});
	const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
	return { home, repo, main, workBrowser, newHead, run, calls };
};

test("--dry-run reads only", () => {
	const t = setup();
	const before = git(t.repo, "rev-parse", "HEAD");
	const run = t.run("--dry-run");
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.match(run.stdout, /would: fast-forward main/);
	assert.match(run.stdout, /would: quit work's browser/);
	assert.equal(git(t.repo, "rev-parse", "HEAD"), before);
	assert.equal(existsSync(join(t.home, ".local", "bin", "ccp")), false);
	assert.deepEqual(t.calls().filter((call) => !call.startsWith("list")), []);
	assert.ok(alive(t.workBrowser));
	assert.ok(alive(t.main));
});

test("a real run updates, links, migrates and quits only the old profile's browser, and is safe to repeat", async () => {
	const t = setup();
	const run = t.run();
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.equal(git(t.repo, "rev-parse", "HEAD"), t.newHead);
	const link = join(t.home, ".local", "bin", "ccp");
	assert.ok(lstatSync(link).isSymbolicLink());
	assert.equal(readlinkSync(link), join(t.repo, "launcher", "bin", "ccp"));
	assert.ok(t.calls().includes("install-host --chromium-default"));
	assert.ok(t.calls().includes("migrate --json"));
	assert.match(run.stdout, /work \(ap@example.com\): imported/);
	assert.match(run.stdout, /Needs one sign-in in the main Chromium: ap@example.com/);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(alive(t.workBrowser), false);
	assert.ok(alive(t.main));
	const again = t.run();
	assert.equal(again.status, 0, again.stdout + again.stderr);
	assert.match(again.stdout, /already at origin\/main/);
	assert.match(again.stdout, /already links to/);
	assert.match(again.stdout, /no old profile browser to quit/);
});

test("stops for the hand step when the extension is not loaded, quitting nothing", () => {
	const t = setup({ extension: false });
	const run = t.run();
	assert.equal(run.status, 3, run.stdout + run.stderr);
	assert.match(run.stdout, /Load unpacked/);
	assert.ok(!t.calls().includes("migrate --json"));
	assert.ok(alive(t.workBrowser));
});

test("stops when the loaded extension does not answer, quitting nothing", () => {
	const t = setup({ connected: false });
	const run = t.run();
	assert.equal(run.status, 3, run.stdout + run.stderr);
	assert.match(run.stdout, /Reload extension/);
	assert.ok(!t.calls().includes("migrate --json"));
	assert.ok(alive(t.workBrowser));
});

test("keeps a profile running when its session could not be read", () => {
	const t = setup({ outcome: "unreachable" });
	const run = t.run();
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.match(run.stdout, /work: kept running/);
	assert.ok(alive(t.workBrowser));
});

test("refuses a checkout with local changes", () => {
	const t = setup();
	writeFileSync(join(t.repo, "launcher", "bin", "ccp"), "#!/bin/sh\n");
	const run = t.run();
	assert.equal(run.status, 1);
	assert.match(run.stderr, /local changes/);
	assert.ok(alive(t.workBrowser));
});
