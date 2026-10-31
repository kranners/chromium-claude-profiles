import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { ccpHome, profilesFile, userDataDir } from "../src/paths.ts";
import { handle } from "../src/protocol.ts";
import { addProfile, readProfiles } from "../src/store.ts";
import { tempContext } from "./helpers.ts";

test("add, list and remove round-trip", async () => {
	const ctx = tempContext();
	const added = await handle({ type: "profiles.add", name: "one", email: "one@example.com" }, ctx);
	assert.equal(added.ok, true);
	const listed = await handle({ type: "profiles.list" }, ctx);
	assert.ok(listed.ok);
	assert.deepEqual(
		(listed as { profiles: { name: string; running: boolean; pid: null }[] }).profiles.map(({ name, running, pid }) => ({ name, running, pid })),
		[{ name: "one", running: false, pid: null }],
	);
	assert.deepEqual(await handle({ type: "profiles.remove", name: "one" }, ctx), { ok: true });
	const empty = await handle({ type: "profiles.list" }, ctx);
	assert.deepEqual((empty as { profiles: unknown[] }).profiles, []);
});

test("invalid names are rejected", async () => {
	const ctx = tempContext();
	for (const name of ["A", "-a", "a".repeat(33), "a/b", "", 7]) {
		const result = await handle({ type: "profiles.add", name }, ctx);
		assert.equal(result.ok, false, `accepted ${name}`);
		assert.equal(!result.ok && result.error.code, "invalid_request");
	}
	assert.equal((await handle({ type: "profiles.add", name: "a".repeat(32) }, ctx)).ok, true);
});

test("a duplicate email in different case is rejected", async () => {
	const ctx = tempContext();
	assert.equal((await handle({ type: "profiles.add", name: "a", email: "a@example.com" }, ctx)).ok, true);
	const duplicate = await handle({ type: "profiles.add", name: "b", email: "A@Example.com" }, ctx);
	assert.equal(!duplicate.ok && duplicate.error.code, "already_exists");
	const sameName = await handle({ type: "profiles.add", name: "a" }, ctx);
	assert.equal(!sameName.ok && sameName.error.code, "already_exists");
});

test("profiles.json is mode 0600 and the home is 0700", async () => {
	const ctx = tempContext();
	await handle({ type: "profiles.add", name: "a" }, ctx);
	assert.equal(statSync(profilesFile(ctx.home)).mode & 0o777, 0o600);
	assert.equal(statSync(ctx.home).mode & 0o777, 0o700);
});

test("remove deletes the data directory unless keepData", async () => {
	const ctx = tempContext();
	await handle({ type: "profiles.add", name: "gone" }, ctx);
	await handle({ type: "profiles.add", name: "kept" }, ctx);
	assert.ok(existsSync(userDataDir(ctx.home, "gone")));
	await handle({ type: "profiles.remove", name: "gone" }, ctx);
	await handle({ type: "profiles.remove", name: "kept", keepData: true }, ctx);
	assert.equal(existsSync(userDataDir(ctx.home, "gone")), false);
	assert.equal(existsSync(userDataDir(ctx.home, "kept")), true);
	const missing = await handle({ type: "profiles.remove", name: "gone" }, ctx);
	assert.equal(!missing.ok && missing.error.code, "not_found");
});

test("configDir must be an absolute existing directory, and env needs it", async () => {
	const ctx = tempContext();
	const relative = await handle({ type: "profiles.add", name: "a", configDir: "relative" }, ctx);
	assert.equal(!relative.ok && relative.error.code, "invalid_request");
	assert.equal((await handle({ type: "profiles.add", name: "a", configDir: ctx.home }, ctx)).ok, true);
	assert.deepEqual(await handle({ type: "profiles.env", name: "a" }, ctx), {
		ok: true,
		env: { CLAUDE_CONFIG_DIR: ctx.home },
		unset: ["CLAUDE_CODE_OAUTH_TOKEN"],
	});
	await handle({ type: "profiles.add", name: "b" }, ctx);
	const noConfig = await handle({ type: "profiles.env", name: "b" }, ctx);
	assert.equal(!noConfig.ok && noConfig.error.code, "invalid_request");
});

test("a relative CCP_HOME resolves to an absolute home", () => {
	assert.equal(ccpHome({ CCP_HOME: "relhome" }), resolve("relhome"));
});

const writeRaw = (home: string, profiles: unknown[]): void => {
	mkdirSync(home, { recursive: true });
	writeFileSync(profilesFile(home), JSON.stringify({ schemaVersion: 1, profiles }));
};

test("entries missing email or configDir are kept and still count for duplicates", async () => {
	const ctx = tempContext();
	writeRaw(ctx.home, [{ name: "old", email: "a@example.com", createdAt: "2026-01-01T00:00:00.000Z", extra: 1 }]);
	assert.deepEqual(readProfiles(ctx.home), [
		{ name: "old", email: "a@example.com", configDir: null, createdAt: "2026-01-01T00:00:00.000Z", extra: 1 },
	]);
	const duplicate = await handle({ type: "profiles.add", name: "new", email: "a@example.com" }, ctx);
	assert.equal(!duplicate.ok && duplicate.error.code, "already_exists");
	assert.equal((await handle({ type: "profiles.add", name: "new" }, ctx)).ok, true);
	assert.deepEqual(readProfiles(ctx.home).map((profile) => profile.name), ["old", "new"]);
});

test("an unusable entry throws instead of being dropped on the next write", () => {
	const ctx = tempContext();
	writeRaw(ctx.home, [{ name: "ok", createdAt: "x" }, { email: "nameless@example.com" }]);
	assert.throws(() => readProfiles(ctx.home), /unknown schema/);
	assert.throws(() => addProfile(ctx.home, { name: "another" }), /unknown schema/);
	assert.equal(JSON.parse(readFileSync(profilesFile(ctx.home), "utf8")).profiles.length, 2);
});

test("concurrent adds from separate processes keep every profile", async () => {
	const ctx = tempContext();
	const storeUrl = new URL("../src/store.ts", import.meta.url).href;
	const names = Array.from({ length: 12 }, (_, index) => `p${index}`);
	await Promise.all(
		names.map(
			(name) =>
				new Promise<void>((resolveRun, rejectRun) => {
					const child = spawn(process.execPath, [
						"--input-type=module",
						"-e",
						`import { addProfile } from ${JSON.stringify(storeUrl)}; if (!addProfile(${JSON.stringify(ctx.home)}, { name: ${JSON.stringify(name)} }).ok) process.exit(2);`,
					]);
					child.on("error", rejectRun);
					child.on("exit", (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${name} exited ${code}`))));
				}),
		),
	);
	assert.deepEqual(readProfiles(ctx.home).map((profile) => profile.name).sort(), [...names].sort());
	assert.equal(existsSync(`${profilesFile(ctx.home)}.lock`), false);
});

test("a lock left by a dead process is broken", () => {
	const ctx = tempContext();
	mkdirSync(ctx.home, { recursive: true });
	const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
	writeFileSync(`${profilesFile(ctx.home)}.lock`, dead.stdout);
	assert.equal(addProfile(ctx.home, { name: "a" }).ok, true);
	assert.equal(existsSync(`${profilesFile(ctx.home)}.lock`), false);
});
