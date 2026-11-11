import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { accountState, migrate, openAccount, openFor, resolveAccount, slug, toViews, writeAccountsStatus } from "../src/accounts.ts";
import type { AccountSummary } from "../src/accounts.ts";
import { callBridge, MAIN_BRIDGE_TYPES, serveBridge } from "../src/bridge.ts";
import type { BridgeRequest } from "../src/bridge.ts";
import { EXPECTED_ORIGIN, createNativeHandler } from "../src/nativeHost.ts";
import { accountsStatusFile, bridgeSocket } from "../src/paths.ts";
import { handle } from "../src/protocol.ts";
import { addProfile } from "../src/store.ts";
import { tempContext } from "./helpers.ts";

const SECRET = "sk-fixture-cookie-value";

type FakeBrowser = { requests: BridgeRequest[]; close: () => Promise<void> };

const fakeBrowser = async (
	socket: string,
	answer: (request: BridgeRequest) => unknown,
	allowed: readonly string[] = [...MAIN_BRIDGE_TYPES, "accounts.exportLive"],
): Promise<FakeBrowser> => {
	const requests: BridgeRequest[] = [];
	let bridge: Awaited<ReturnType<typeof serveBridge>>;
	bridge = await serveBridge(socket, allowed, (msg) => {
		requests.push(msg.request);
		setImmediate(() => bridge.reply({ type: "bridge.reply", id: msg.id, response: answer(msg.request) }));
	});
	return { requests, close: bridge.close };
};

const summary = (label: string, extra: Partial<AccountSummary> = {}): AccountSummary => ({
	label,
	email: `${label.toLowerCase().replace(/ /g, "")}@example.com`,
	status: "ok",
	checkedAt: "2026-11-04T00:00:00.000Z",
	sessionExpiresAt: "2027-01-01T00:00:00.000Z",
	...extra,
});

const mainList = (accounts: AccountSummary[], active: string | null) => ({ ok: true, accounts, active });

test("the bridge forwards one request per connection and answers on the same socket", async () => {
	const ctx = tempContext();
	const socket = bridgeSocket(ctx.home, "main");
	const browser = await fakeBrowser(socket, (request) => ({ ok: true, echoed: request.type }));
	try {
		assert.equal(statSync(socket).mode & 0o777, 0o600);
		assert.equal(statSync(dirname(socket)).mode & 0o777, 0o700);
		assert.deepEqual(await callBridge(socket, { type: "accounts.list" }), { ok: true, echoed: "accounts.list" });
		assert.deepEqual(browser.requests, [{ type: "accounts.list" }]);
		const refused = await callBridge(socket, { type: "accounts.forget" });
		assert.equal(!refused.ok && refused.error.code, "unsupported");
		assert.equal(browser.requests.length, 1);
	} finally {
		await browser.close();
	}
	const gone = await callBridge(socket, { type: "ping" });
	assert.equal(!gone.ok && gone.error.code, "browser_unavailable");
});

test("a browser that never answers times out", async () => {
	const ctx = tempContext();
	const socket = bridgeSocket(ctx.home, "main");
	const bridge = await serveBridge(socket, ["ping"], () => undefined);
	try {
		const result = await callBridge(socket, { type: "ping" }, 50);
		assert.equal(!result.ok && result.error.code, "internal");
	} finally {
		await bridge.close();
	}
});

test("bridge.attach serves the main socket from the main browser and a profile socket from an old profile", async () => {
	const main = tempContext();
	const written: unknown[] = [];
	const handler = createNativeHandler(EXPECTED_ORIGIN, main, (msg) => written.push(msg));
	assert.deepEqual(await handler({ type: "bridge.attach" }), { ok: true, attached: true, browser: "main" });
	const pending = callBridge(bridgeSocket(main.home, "main"), { type: "accounts.list" });
	while (written.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
	const forwarded = written[0] as { id: number; request: BridgeRequest };
	assert.deepEqual(forwarded.request, { type: "accounts.list" });
	assert.equal(await handler({ type: "bridge.reply", id: forwarded.id, response: { ok: true, accounts: [], active: null } }), undefined);
	assert.deepEqual(await pending, { ok: true, accounts: [], active: null });
	await handler.bridge()?.close();

	const old = { ...tempContext(), current: "a" };
	const profileHandler = createNativeHandler(EXPECTED_ORIGIN, old, () => undefined);
	assert.deepEqual(await profileHandler({ type: "bridge.attach" }), { ok: true, attached: true, browser: "a" });
	const refused = await callBridge(bridgeSocket(old.home, "profile-a"), { type: "accounts.open", label: "x" });
	assert.equal(!refused.ok && refused.error.code, "unsupported");
	await profileHandler.bridge()?.close();

	const stranger = createNativeHandler("chrome-extension://other/", main);
	assert.equal(((await stranger({ type: "bridge.attach" })) as { ok: boolean }).ok, false);
});

test("account state follows the check and the session cookie's expiry", () => {
	const now = Date.parse("2026-11-04T00:00:00.000Z");
	assert.equal(accountState(summary("a"), now), "signed-in");
	assert.equal(accountState(summary("a", { sessionExpiresAt: "2026-11-05T00:00:00.000Z" }), now), "expiring");
	assert.equal(accountState(summary("a", { sessionExpiresAt: "2026-11-03T00:00:00.000Z" }), now), "signed-out");
	assert.equal(accountState(summary("a", { status: "revoked" }), now), "signed-out");
	assert.equal(accountState(summary("a", { status: "unknown" }), now), "unknown");
	assert.equal(accountState(summary("a", { status: null, sessionExpiresAt: null }), now), "unknown");
});

test("accounts get stable profile-style names and resolve by name, label or email", () => {
	assert.equal(slug("Work AP2"), "work-ap2");
	assert.equal(slug("me@example.com"), "me-example-com");
	assert.equal(slug("..."), "account");
	const views = toViews([summary("Work"), summary("work"), summary("Personal")], "Personal");
	assert.deepEqual(views.map((view) => [view.label, view.name, view.active]), [
		["Personal", "personal", true],
		["Work", "work", false],
		["work", "work-2", false],
	]);
	assert.equal(resolveAccount(views, "work-2")?.label, "work");
	assert.equal(resolveAccount(views, "PERSONAL@example.com")?.label, "Personal");
	assert.equal(resolveAccount(views, "nobody"), null);
});

test("the status file keeps only the summary fields, mode 0600", () => {
	const ctx = tempContext();
	assert.deepEqual(writeAccountsStatus(ctx.home, [{ ...summary("Work"), cookies: [{ value: SECRET }], value: SECRET }]), { ok: true });
	const text = readFileSync(accountsStatusFile(ctx.home), "utf8");
	assert.equal(text.includes(SECRET), false);
	assert.equal(statSync(accountsStatusFile(ctx.home)).mode & 0o777, 0o600);
	const body = JSON.parse(text);
	assert.equal(body.schemaVersion, 1);
	assert.deepEqual(Object.keys(body.accounts[0]).sort(), ["checkedAt", "email", "label", "name", "sessionExpiresAt", "state", "status"]);
	assert.equal(writeAccountsStatus(ctx.home, [{ label: "../x" }]).ok, false);
});

test("list falls back to the status file when the main browser is not connected", async () => {
	const ctx = tempContext();
	writeAccountsStatus(ctx.home, [summary("Work", { status: "revoked" })]);
	const result = (await handle({ type: "accounts.list" }, ctx)) as unknown as {
		browser: { connected: boolean };
		accounts: { state: string }[];
	};
	assert.equal(result.browser.connected, false);
	assert.equal(result.accounts[0].state, "signed-out");
});

test("launch switches the main browser's account and opens the url there, by account, email or old profile name", async () => {
	const ctx = tempContext();
	addProfile(ctx.home, { name: "old-work", email: "work@example.com" });
	const browser = await fakeBrowser(bridgeSocket(ctx.home, "main"), (request) =>
		request.type === "accounts.open" ? { ok: true, switched: true, reloadedTabs: 2, tabId: 7 } : mainList([summary("Work"), summary("Personal")], "Personal"),
	);
	try {
		const result = (await openAccount(ctx, "work", "https://claude.ai/code")) as unknown as { ok: boolean; switched: boolean; account: { label: string } };
		assert.equal(result.ok, true);
		assert.equal(result.switched, true);
		assert.equal(result.account.label, "Work");
		assert.deepEqual(browser.requests.at(-1), { type: "accounts.open", label: "Work", url: "https://claude.ai/code" });
		assert.equal((await openAccount(ctx, "old-work", undefined)).ok, true);
		assert.deepEqual(browser.requests.at(-1), { type: "accounts.open", label: "Work", url: null });
		const missing = await openAccount(ctx, "nobody", undefined);
		assert.equal(!missing.ok && missing.error.code, "not_found");
		const flag = await openAccount(ctx, "work", "--evil");
		assert.equal(!flag.ok && flag.error.code, "invalid_request");
	} finally {
		await browser.close();
	}
});

test("open-for takes only claude.ai links and reports the account that could see it", async () => {
	const ctx = tempContext();
	for (const url of ["https://example.com/code/session_1", "http://claude.ai/code/session_1", "--x"]) {
		const result = await openFor(ctx, url);
		assert.equal(!result.ok && result.error.code, "invalid_request", url);
	}
	const browser = await fakeBrowser(bridgeSocket(ctx.home, "main"), (request) =>
		request.type === "accounts.openFor"
			? { ok: true, label: "Work", tabId: 3, tried: [{ label: "Personal", result: "not-found" }, { label: "Work", result: "found" }] }
			: mainList([summary("Work"), summary("Personal")], "Work"),
	);
	try {
		const result = (await openFor(ctx, "https://claude.ai/code/session_1")) as unknown as { ok: boolean; account: { label: string }; tried: unknown[] };
		assert.equal(result.ok, true);
		assert.equal(result.account.label, "Work");
		assert.equal(result.tried.length, 2);
	} finally {
		await browser.close();
	}
});

test("migrate moves each old profile's live session into the main browser and never prints cookies", async () => {
	const ctx = tempContext();
	addProfile(ctx.home, { name: "work", email: "work@example.com" });
	addProfile(ctx.home, { name: "gone", email: "gone@example.com" });
	addProfile(ctx.home, { name: "dead", email: "dead@example.com" });
	const main = await fakeBrowser(bridgeSocket(ctx.home, "main"), (request) => {
		if (request.type === "accounts.import") {
			assert.deepEqual(request.cookies, [{ name: "sessionKey", value: SECRET }]);
			return { ok: true, imported: true, label: request.label };
		}
		return mainList([summary("work@example.com"), summary("gone@example.com", { status: "revoked" })], null);
	});
	const profiles: FakeBrowser[] = [];
	const launched: string[] = [];
	const launch = async (_ctx: unknown, profile: { name: string }) => {
		launched.push(profile.name);
		if (profile.name === "dead") return { ok: false as const, error: { code: "internal" as const, message: "Chromium did not start" } };
		profiles.push(
			await fakeBrowser(
				bridgeSocket(ctx.home, `profile-${profile.name}`),
				(request) =>
					request.type === "ping"
						? { ok: true }
						: profile.name === "work"
							? { ok: true, email: "work@example.com", cookies: [{ name: "sessionKey", value: SECRET }] }
							: { ok: false, error: { code: "session_expired", message: "Not signed in to claude.ai" } },
				["ping", "accounts.exportLive"],
			),
		);
		return { ok: true as const, pid: null };
	};
	try {
		const result = await migrate(ctx, { launch });
		assert.equal(JSON.stringify(result).includes(SECRET), false);
		const body = result as unknown as { profiles: { profile: string; outcome: string }[]; needSignIn: string[] };
		assert.deepEqual(launched, ["work", "gone", "dead"]);
		assert.deepEqual(
			body.profiles.map((row) => [row.profile, row.outcome]),
			[
				["work", "imported"],
				["gone", "signed-out"],
				["dead", "unreachable"],
			],
		);
		assert.deepEqual(body.needSignIn, ["gone@example.com"]);
	} finally {
		await main.close();
		for (const profile of profiles) await profile.close();
	}
});

test("an email with a plus is a saved account's label as it stands", () => {
	const ctx = tempContext();
	const plus = { ...summary("Work"), label: "a+work@example.com", email: "a+work@example.com" };
	assert.deepEqual(writeAccountsStatus(ctx.home, [plus]), { ok: true });
	const body = JSON.parse(readFileSync(accountsStatusFile(ctx.home), "utf8"));
	assert.equal(body.accounts[0].label, "a+work@example.com");
	assert.equal(resolveAccount(toViews([plus], null), "a+work@example.com")?.label, "a+work@example.com");
});

test("save without a label lets the browser name the account by its email", async () => {
	const ctx = tempContext();
	const browser = await fakeBrowser(bridgeSocket(ctx.home, "main"), () => ({ ok: true, account: { label: "a@example.com", email: "a@example.com" } }));
	try {
		const saved = await handle({ type: "accounts.save" }, ctx);
		assert.equal(saved.ok, true);
		assert.deepEqual(browser.requests, [{ type: "accounts.save" }]);
		assert.equal((await handle({ type: "accounts.save", label: 3 }, ctx)).ok, false);
	} finally {
		await browser.close();
	}
});
