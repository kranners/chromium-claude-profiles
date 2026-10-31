import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { statSync } from "node:fs";
import { after, before, test } from "node:test";
import { tokenFile } from "../src/paths.ts";
import { createApiServer, listen, matchRoute } from "../src/server.ts";
import { ensureToken } from "../src/token.ts";
import { tempContext } from "./helpers.ts";

const ctx = tempContext();
const token = ensureToken(ctx.home);
const server = createApiServer({ home: ctx.home, env: ctx.env, token });
let port = 0;

before(async () => {
	port = await listen(server, 0);
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Reply = { status: number; headers: Record<string, unknown>; body: { ok: boolean; error?: { code: string } } };

const call = (
	method: string,
	path: string,
	{ auth, body, contentType, host }: { auth?: string; body?: string; contentType?: string; host?: string } = {},
): Promise<Reply> =>
	new Promise((resolve, reject) => {
		const headers: Record<string, string> = { host: host ?? `127.0.0.1:${port}` };
		if (auth !== undefined) headers.authorization = `Bearer ${auth}`;
		if (contentType !== undefined) headers["content-type"] = contentType;
		const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
			let text = "";
			res.on("data", (chunk) => (text += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(text) }));
		});
		req.on("error", reject);
		req.end(body);
	});

test("the token file is 64 hex chars, mode 0600, and stable", () => {
	assert.match(token, /^[0-9a-f]{64}$/);
	assert.equal(statSync(tokenFile(ctx.home)).mode & 0o777, 0o600);
	assert.equal(ensureToken(ctx.home), token);
});

test("listens on 127.0.0.1 only", () => {
	assert.equal((server.address() as AddressInfo).address, "127.0.0.1");
});

test("health needs no token", async () => {
	const reply = await call("GET", "/v1/health");
	assert.equal(reply.status, 200);
	assert.deepEqual(reply.body, { ok: true, version: "0.1.0" });
	assert.equal(reply.headers["cache-control"], "no-store");
	assert.equal(reply.headers["access-control-allow-origin"], undefined);
});

test("profiles need the right token", async () => {
	assert.equal((await call("GET", "/v1/profiles")).status, 401);
	assert.equal((await call("GET", "/v1/profiles", { auth: "0".repeat(64) })).status, 401);
	assert.equal((await call("GET", "/v1/profiles", { auth: "short" })).status, 401);
	const ok = await call("GET", "/v1/profiles", { auth: token });
	assert.equal(ok.status, 200);
	assert.equal(ok.body.ok, true);
});

test("a foreign Host header is 403", async () => {
	assert.equal((await call("GET", "/v1/health", { host: "evil.example.com" })).status, 403);
	assert.equal((await call("GET", "/v1/health", { host: `127.0.0.1:${port + 1}` })).status, 403);
	assert.equal((await call("GET", "/v1/health", { host: `localhost:${port}` })).status, 200);
});

test("POST without JSON is 400", async () => {
	assert.equal((await call("POST", "/v1/profiles", { auth: token, body: "name=a", contentType: "text/plain" })).status, 400);
	assert.equal((await call("POST", "/v1/profiles", { auth: token, body: "{", contentType: "application/json" })).status, 400);
	assert.equal(
		(await call("POST", "/v1/profiles", { auth: token, body: JSON.stringify({ name: "x".repeat(17000) }), contentType: "application/json" }))
			.status,
		400,
	);
});

test("add is 201, a duplicate is 409, then status, env and remove", async () => {
	const body = JSON.stringify({ name: "srv", email: "srv@example.com" });
	assert.equal((await call("POST", "/v1/profiles", { auth: token, body, contentType: "application/json" })).status, 201);
	const duplicate = await call("POST", "/v1/profiles", {
		auth: token,
		body: JSON.stringify({ name: "srv2", email: "SRV@example.com" }),
		contentType: "application/json; charset=utf-8",
	});
	assert.equal(duplicate.status, 409);
	assert.equal(duplicate.body.error?.code, "already_exists");
	assert.equal((await call("GET", "/v1/profiles/srv", { auth: token })).status, 200);
	assert.equal((await call("GET", "/v1/profiles/srv/env", { auth: token })).status, 400);
	assert.equal((await call("POST", "/v1/profiles/srv/launch", { auth: token })).status, 422);
	assert.equal((await call("DELETE", "/v1/profiles/srv?keepData=1", { auth: token })).status, 200);
	assert.equal((await call("GET", "/v1/profiles/srv", { auth: token })).status, 404);
});

test("unknown routes are 404 and wrong methods 405", async () => {
	assert.equal((await call("GET", "/v1/nope", { auth: token })).status, 404);
	assert.equal((await call("PUT", "/v1/profiles", { auth: token })).status, 405);
});

test("matchRoute maps every route", () => {
	assert.deepEqual(matchRoute("GET", "/v1/health"), { kind: "health" });
	assert.deepEqual(matchRoute("GET", "/v1/profiles"), { kind: "list" });
	assert.deepEqual(matchRoute("POST", "/v1/profiles"), { kind: "add" });
	assert.deepEqual(matchRoute("GET", "/v1/profiles/a"), { kind: "status", name: "a" });
	assert.deepEqual(matchRoute("DELETE", "/v1/profiles/a"), { kind: "remove", name: "a" });
	assert.deepEqual(matchRoute("POST", "/v1/profiles/a/launch"), { kind: "launch", name: "a" });
	assert.deepEqual(matchRoute("GET", "/v1/profiles/a/env"), { kind: "env", name: "a" });
	assert.deepEqual(matchRoute("GET", "/v1/profiles/a/launch"), { kind: "method-not-allowed" });
	assert.deepEqual(matchRoute("POST", "/v1/health"), { kind: "method-not-allowed" });
	assert.deepEqual(matchRoute("GET", "/v1/profiles/a/b"), { kind: "not-found" });
	assert.deepEqual(matchRoute("GET", "/"), { kind: "not-found" });
});
