import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handle } from "./protocol.ts";
import type { ErrorCode, Failure, Result } from "./protocol.ts";
import { fail } from "./store.ts";
import { tokensMatch } from "./token.ts";

export type Route =
	| { kind: "health" }
	| { kind: "list" }
	| { kind: "add" }
	| { kind: "status"; name: string }
	| { kind: "remove"; name: string }
	| { kind: "launch"; name: string }
	| { kind: "env"; name: string }
	| { kind: "accounts" }
	| { kind: "account"; name: string }
	| { kind: "open"; name: string }
	| { kind: "open-for" }
	| { kind: "not-found" }
	| { kind: "method-not-allowed" };

const MAX_BODY_BYTES = 16 * 1024;
const LISTEN_HOST = "127.0.0.1";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
	invalid_request: 400,
	unauthorized: 401,
	not_found: 404,
	already_exists: 409,
	running: 409,
	chromium_not_found: 422,
	unsupported: 422,
	native_host_unavailable: 500,
	browser_unavailable: 503,
	session_expired: 409,
	internal: 500,
};

const decodeSegment = (segment: string): string | null => {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
};

const byMethod = (method: string, routes: Record<string, Route>): Route =>
	routes[method] ?? { kind: "method-not-allowed" };

export const matchRoute = (method: string, pathname: string): Route => {
	if (pathname === "/v1/health") return byMethod(method, { GET: { kind: "health" } });
	if (pathname === "/v1/accounts") return byMethod(method, { GET: { kind: "accounts" } });
	if (pathname === "/v1/open-for") return byMethod(method, { POST: { kind: "open-for" } });
	const account = /^\/v1\/accounts\/([^/]+)(?:\/(open))?$/.exec(pathname);
	if (account) {
		const name = decodeSegment(account[1]);
		if (name === null) return { kind: "not-found" };
		return account[2] === "open" ? byMethod(method, { POST: { kind: "open", name } }) : byMethod(method, { GET: { kind: "account", name } });
	}
	if (pathname === "/v1/profiles") return byMethod(method, { GET: { kind: "list" }, POST: { kind: "add" } });
	const match = /^\/v1\/profiles\/([^/]+)(?:\/(launch|env))?$/.exec(pathname);
	const name = match ? decodeSegment(match[1]) : null;
	if (!match || name === null) return { kind: "not-found" };
	if (match[2] === "launch") return byMethod(method, { POST: { kind: "launch", name } });
	if (match[2] === "env") return byMethod(method, { GET: { kind: "env", name } });
	return byMethod(method, { GET: { kind: "status", name }, DELETE: { kind: "remove", name } });
};

const send = (res: ServerResponse, status: number, body: object): void => {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(text),
	});
	res.end(text);
};

const sendFailure = (res: ServerResponse, status: number, code: ErrorCode, message: string): void =>
	send(res, status, fail(code, message));

class BodyError extends Error {}

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new BodyError("Body exceeds 16 KiB");
		chunks.push(chunk as Buffer);
	}
	if (size === 0) return {};
	const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
	if (contentType !== "application/json") throw new BodyError("content-type must be application/json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new BodyError("Body is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BodyError("Body must be a JSON object");
	return parsed as Record<string, unknown>;
};

const requestFor = (route: Route, body: Record<string, unknown>, url: URL): object | null => {
	switch (route.kind) {
		case "health":
			return { type: "ping" };
		case "list":
			return { type: "profiles.list" };
		case "add":
			return { type: "profiles.add", name: body.name, email: body.email, configDir: body.configDir };
		case "status":
			return { type: "profiles.status", name: route.name };
		case "remove":
			return { type: "profiles.remove", name: route.name, keepData: url.searchParams.get("keepData") === "1" };
		case "launch":
			return { type: "profiles.launch", name: route.name, url: body.url };
		case "env":
			return { type: "profiles.env", name: route.name };
		case "accounts":
			return { type: "accounts.list" };
		case "account":
			return { type: "accounts.status", name: route.name };
		case "open":
			return { type: "accounts.open", name: route.name, url: body.url };
		case "open-for":
			return { type: "accounts.openFor", url: body.url };
		default:
			return null;
	}
};

export type ServerOptions = { home: string; env: NodeJS.ProcessEnv; token: string };

export const createApiServer = ({ home, env, token }: ServerOptions): Server => {
	const server = createServer(async (req, res) => {
		const port = (server.address() as AddressInfo).port;
		const host = req.headers.host ?? "";
		if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
			return sendFailure(res, 403, "unauthorized", "Host header not allowed");
		}
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		const route = matchRoute(req.method ?? "GET", url.pathname);
		if (route.kind === "not-found") return sendFailure(res, 404, "not_found", "Unknown route");
		if (route.kind === "method-not-allowed") return sendFailure(res, 405, "invalid_request", "Method not allowed");
		if (route.kind !== "health") {
			const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
			if (!tokensMatch(token, presented)) return sendFailure(res, 401, "unauthorized", "Missing or wrong bearer token");
		}
		let body: Record<string, unknown>;
		try {
			body = await readBody(req);
		} catch (error) {
			if (error instanceof BodyError) return sendFailure(res, 400, "invalid_request", error.message);
			return sendFailure(res, 500, "internal", "Could not read body");
		}
		const result: Result<object> = await handle(requestFor(route, body, url), { home, env, current: null });
		if (!result.ok) return send(res, STATUS_BY_CODE[(result as Failure).error.code], result);
		send(res, route.kind === "add" ? 201 : 200, result);
	});
	return server;
};

export const listen = (server: Server, port: number): Promise<number> =>
	new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, LISTEN_HOST, () => {
			server.off("error", reject);
			resolve((server.address() as AddressInfo).port);
		});
	});
