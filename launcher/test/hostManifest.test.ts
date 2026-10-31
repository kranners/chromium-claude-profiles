import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildHostManifest, EXTENSION_ID, HOST_NAME, installHostInto, writeWrapper } from "../src/hostManifest.ts";
import { repoRoot } from "../src/paths.ts";
import { tempDir } from "./helpers.ts";

const idFromKey = (base64Key: string): string =>
	createHash("sha256")
		.update(Buffer.from(base64Key, "base64"))
		.digest("hex")
		.slice(0, 32)
		.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));

test("the manifest allows exactly our extension", () => {
	assert.deepEqual(buildHostManifest("/w/native-host"), {
		name: "engineer.cute.claude_profiles",
		description: "Claude Profiles launcher",
		path: "/w/native-host",
		type: "stdio",
		allowed_origins: ["chrome-extension://bkgjdpakjigjgdggfcckikppbjjcdkim/"],
	});
});

test("the extension key hashes to the extension id", () => {
	const { key } = JSON.parse(readFileSync(join(repoRoot, "extension", "manifest.json"), "utf8"));
	assert.equal(idFromKey(key), EXTENSION_ID);
});

test("installHostInto copies the Claude Code manifest only when it exists", () => {
	const home = tempDir();
	const sourceDir = tempDir();
	const source = join(sourceDir, "com.anthropic.claude_code_browser_extension.json");
	const without = join(tempDir(), "NativeMessagingHosts");
	installHostInto(home, without, source);
	assert.ok(existsSync(join(without, `${HOST_NAME}.json`)));
	assert.equal(existsSync(join(without, "com.anthropic.claude_code_browser_extension.json")), false);
	writeFileSync(source, '{"name":"com.anthropic.claude_code_browser_extension"}');
	const withCopy = join(tempDir(), "NativeMessagingHosts");
	installHostInto(home, withCopy, source);
	assert.equal(
		readFileSync(join(withCopy, "com.anthropic.claude_code_browser_extension.json"), "utf8"),
		'{"name":"com.anthropic.claude_code_browser_extension"}',
	);
	assert.equal(JSON.parse(readFileSync(join(withCopy, `${HOST_NAME}.json`), "utf8")).path, join(home, "bin", "native-host"));
});

test("the wrapper is executable and runs the CLI in native-host mode with absolute paths", () => {
	const home = tempDir();
	const path = writeWrapper(home);
	assert.equal(statSync(path).mode & 0o777, 0o755);
	const script = readFileSync(path, "utf8");
	assert.ok(script.startsWith("#!/bin/sh\nexec "));
	assert.ok(script.includes(`'${process.execPath}'`));
	assert.ok(script.includes(`'${join(repoRoot, "launcher", "src", "cli.ts")}' native-host "$@"`));
});
