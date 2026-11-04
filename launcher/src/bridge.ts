import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { dirname } from "node:path";
import type { Result } from "./protocol.ts";
import { fail } from "./store.ts";

export const MAIN_BROWSER = "main";

export const MAIN_BRIDGE_TYPES: readonly string[] = ["ping", "accounts.list", "accounts.check", "accounts.open", "accounts.openFor", "accounts.import"];
export const PROFILE_BRIDGE_TYPES: readonly string[] = ["ping", "accounts.exportLive"];

const MAX_LINE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export type BridgeRequest = { type: string; [param: string]: unknown };
export type Bridge = { socket: string; close: () => Promise<void>; reply: (msg: unknown) => void };

type Pending = { resolve: (response: unknown) => void; timer: NodeJS.Timeout };

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readLine = (socket: Socket, onLine: (line: string) => void, onTooLong: () => void): void => {
	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffered += chunk;
		const newline = buffered.indexOf("\n");
		if (newline >= 0) {
			socket.removeAllListeners("data");
			onLine(buffered.slice(0, newline));
		} else if (buffered.length > MAX_LINE_BYTES) {
			socket.removeAllListeners("data");
			onTooLong();
		}
	});
};

const answer = (socket: Socket, response: unknown): void => {
	socket.end(`${JSON.stringify(response)}\n`);
};

const parseRequest = (line: string): BridgeRequest | null => {
	try {
		const parsed = JSON.parse(line);
		return isObject(parsed) && typeof parsed.type === "string" ? (parsed as BridgeRequest) : null;
	} catch {
		return null;
	}
};

const timeoutFor = (request: BridgeRequest): number => {
	const asked = request.timeoutMs;
	return typeof asked === "number" && Number.isFinite(asked) && asked > 0 ? Math.min(asked, 10 * 60_000) : DEFAULT_TIMEOUT_MS;
};

export const prepareSocket = (socket: string): void => {
	mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
	chmodSync(dirname(socket), 0o700);
	rmSync(socket, { force: true });
};

export const serveBridge = async (
	socket: string,
	allowed: readonly string[],
	toExtension: (msg: { type: "bridge.request"; id: number; request: BridgeRequest }) => void,
): Promise<Bridge> => {
	const pending = new Map<number, Pending>();
	let nextId = 1;
	const forward = (request: BridgeRequest): Promise<unknown> =>
		new Promise((resolve) => {
			const id = nextId++;
			const timer = setTimeout(() => {
				pending.delete(id);
				resolve(fail("internal", "The browser did not answer in time"));
			}, timeoutFor(request));
			pending.set(id, { resolve, timer });
			const { timeoutMs: _timeout, ...rest } = request;
			toExtension({ type: "bridge.request", id, request: rest as BridgeRequest });
		});
	const server: Server = createServer((client) => {
		client.on("error", () => undefined);
		readLine(
			client,
			async (line) => {
				const request = parseRequest(line);
				if (request === null) return answer(client, fail("invalid_request", "Request must be one JSON object with a string type"));
				if (!allowed.includes(request.type)) return answer(client, fail("unsupported", `${request.type} is not available on this browser`));
				answer(client, await forward(request));
			},
			() => answer(client, fail("invalid_request", "Request too large")),
		);
	});
	prepareSocket(socket);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, () => {
			server.off("error", reject);
			resolve();
		});
	});
	chmodSync(socket, 0o600);
	return {
		socket,
		reply: (msg) => {
			if (!isObject(msg) || typeof msg.id !== "number") return;
			const entry = pending.get(msg.id);
			if (!entry) return;
			pending.delete(msg.id);
			clearTimeout(entry.timer);
			entry.resolve(msg.response);
		},
		close: () =>
			new Promise((resolve) => {
				for (const [id, entry] of pending) {
					clearTimeout(entry.timer);
					entry.resolve(fail("browser_unavailable", "The browser disconnected"));
					pending.delete(id);
				}
				server.close(() => {
					rmSync(socket, { force: true });
					resolve();
				});
			}),
	};
};

export const callBridge = (socket: string, request: BridgeRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Result<object>> =>
	new Promise((resolve) => {
		const client = connect(socket);
		let settled = false;
		const settle = (result: Result<object>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			client.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => settle(fail("internal", "The browser did not answer in time")), timeoutMs + 5_000);
		client.on("error", () =>
			settle(fail("browser_unavailable", "Claude Profiles is not connected in your main Chromium; open Chromium, or press Reload extension in the popup")),
		);
		client.on("connect", () => client.write(`${JSON.stringify({ ...request, timeoutMs })}\n`));
		readLine(
			client,
			(line) => {
				try {
					const parsed = JSON.parse(line);
					settle(isObject(parsed) && typeof parsed.ok === "boolean" ? (parsed as Result<object>) : fail("internal", "Malformed answer from the browser"));
				} catch {
					settle(fail("internal", "Malformed answer from the browser"));
				}
			},
			() => settle(fail("internal", "Answer from the browser too large")),
		);
		client.on("end", () => settle(fail("browser_unavailable", "The browser closed the connection without answering")));
	});
