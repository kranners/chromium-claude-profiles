import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromiumDefaultHostsDir, repoRoot } from "../src/paths.ts";

const script = join(repoRoot, "install.sh");

const fakeHome = () => mkdtempSync(join(tmpdir(), "ccp-install-"));

const envFor = (home: string, extra: Record<string, string> = {}) => ({
	PATH: process.env.PATH ?? "",
	HOME: home,
	CCP_HOME: join(home, ".config", "chromium-claude-profiles"),
	CCP_NODE: process.execPath,
	CCP_REPO_URL: repoRoot,
	CCP_DIR: join(home, "checkout"),
	CCP_BROWSER: "chromium",
	...extra,
});

const run = (home: string, args: string[] = [], extra: Record<string, string> = {}) =>
	spawnSync("sh", [script, ...args], { env: envFor(home, extra), encoding: "utf8" });

test("a first run clones, links ccp, installs the host and stops for the extension step", () => {
	const home = fakeHome();
	const result = run(home);
	assert.equal(result.status, 3, result.stdout + result.stderr);
	assert.match(result.stdout, /Load this folder as an unpacked extension in chromium/);
	const link = join(home, ".local", "bin", "ccp");
	assert.equal(readlinkSync(link), join(home, "checkout", "launcher", "bin", "ccp"));
	const env = envFor(home);
	const manifest = JSON.parse(readFileSync(join(chromiumDefaultHostsDir(env), "engineer.cute.claude_profiles.json"), "utf8"));
	assert.equal(manifest.type, "stdio");
	assert.equal(readFileSync(join(env.CCP_HOME, "node"), "utf8").trim(), process.execPath);
	assert.equal(readFileSync(join(env.CCP_HOME, "browser"), "utf8").trim(), "chromium");
});

test("running it again changes nothing and gives the same answer", () => {
	const home = fakeHome();
	const first = run(home);
	const link = join(home, ".local", "bin", "ccp");
	const before = lstatSync(link).mtimeMs;
	const second = run(home);
	assert.equal(second.status, first.status);
	assert.equal(lstatSync(link).mtimeMs, before);
	assert.match(second.stdout, /already points here/);
});

test("--dry-run writes nothing", () => {
	const home = fakeHome();
	const result = run(home, ["--dry-run"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.equal(existsSync(join(home, ".local")), false);
	assert.equal(existsSync(join(home, "checkout")), false);
	assert.equal(existsSync(join(home, ".config")), false);
});

test("a different ccp already on the path is left alone", () => {
	const home = fakeHome();
	mkdirSync(join(home, ".local", "bin"), { recursive: true });
	writeFileSync(join(home, ".local", "bin", "ccp"), "#!/bin/sh\n");
	const result = run(home);
	assert.match(result.stdout, /already exists and is something else; leaving it/);
	assert.equal(readFileSync(join(home, ".local", "bin", "ccp"), "utf8"), "#!/bin/sh\n");
});

test("an unknown browser or option is refused before anything is changed", () => {
	const home = fakeHome();
	assert.equal(run(home, ["--browser", "netscape"], { CCP_BROWSER: "" }).status, 1);
	assert.equal(run(home, ["--nope"]).status, 1);
	assert.equal(existsSync(join(home, ".local")), false);
});

test("it never uses sudo or touches shell startup files", () => {
	const lines = readFileSync(script, "utf8")
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"));
	const code = lines.join("\n");
	assert.doesNotMatch(code, /\bsudo\b|\bsu\b -|\.zshrc|\.bashrc|\.profile|launchctl|defaults write/);
});
