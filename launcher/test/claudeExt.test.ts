import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findClaudeExtension, vendorClaudeExtension } from "../src/claudeExt.ts";
import { tempDir } from "./helpers.ts";

const fakeVersion = (source: string, dirName: string, version: string): void => {
	mkdirSync(join(source, dirName, "_metadata"), { recursive: true });
	writeFileSync(join(source, dirName, "manifest.json"), JSON.stringify({ version }));
	writeFileSync(join(source, dirName, "_metadata", "verified_contents.json"), "{}");
};

test("picks the highest version folder, suffix last", () => {
	const source = tempDir();
	fakeVersion(source, "1.0.9_0", "1.0.9");
	fakeVersion(source, "1.0.102_0", "1.0.102");
	fakeVersion(source, "1.0.102_1", "1.0.102");
	mkdirSync(join(source, "1.0.200_0"));
	assert.deepEqual(findClaudeExtension(source), { version: "1.0.102", dir: join(source, "1.0.102_1") });
});

test("a missing source gives null", () => {
	assert.equal(findClaudeExtension(join(tempDir(), "absent")), null);
	assert.equal(vendorClaudeExtension(tempDir(), join(tempDir(), "absent")), null);
});

test("vendoring copies once, including _metadata, and never overwrites", () => {
	const source = tempDir();
	const home = tempDir();
	fakeVersion(source, "1.0.102_0", "1.0.102");
	const vendored = vendorClaudeExtension(home, source);
	assert.equal(vendored, join(home, "vendor", "claude-in-chrome", "1.0.102_0"));
	assert.ok(existsSync(join(vendored, "_metadata", "verified_contents.json")));
	writeFileSync(join(source, "1.0.102_0", "manifest.json"), JSON.stringify({ version: "changed" }));
	assert.equal(vendorClaudeExtension(home, source), vendored);
	assert.equal(JSON.parse(readFileSync(join(vendored, "manifest.json"), "utf8")).version, "1.0.102");
});

test("a newer source version is vendored alongside", () => {
	const source = tempDir();
	const home = tempDir();
	fakeVersion(source, "1.0.102_0", "1.0.102");
	vendorClaudeExtension(home, source);
	fakeVersion(source, "1.0.103_0", "1.0.103");
	assert.equal(vendorClaudeExtension(home, source), join(home, "vendor", "claude-in-chrome", "1.0.103_0"));
});
