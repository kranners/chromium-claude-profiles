import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { EXTENSION_ID } from "./hostManifest.ts";
import { handleNative } from "./protocol.ts";
import type { Context } from "./protocol.ts";
import { fail, readProfiles } from "./store.ts";
import { userDataDir } from "./paths.ts";
import { userDataDirFromArgs } from "./running.ts";

export const EXPECTED_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
export const MAX_RESPONSE_BYTES = 1_000_000;

export const encodeMessage = (msg: unknown): Buffer => {
	const body = Buffer.from(JSON.stringify(msg), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length, 0);
	return Buffer.concat([header, body]);
};

export const createDecoder = (onMessage: (msg: unknown) => void): ((chunk: Buffer) => void) => {
	let pending = Buffer.alloc(0);
	return (chunk) => {
		pending = Buffer.concat([pending, chunk]);
		while (pending.length >= 4) {
			const length = pending.readUInt32LE(0);
			if (pending.length < 4 + length) return;
			const body = pending.subarray(4, 4 + length).toString("utf8");
			pending = pending.subarray(4 + length);
			let message: unknown;
			try {
				message = JSON.parse(body);
			} catch {
				message = undefined;
			}
			onMessage(message);
		}
	};
};

const encodeCapped = (response: unknown): Buffer => {
	const encoded = encodeMessage(response);
	return encoded.length - 4 > MAX_RESPONSE_BYTES ? encodeMessage(fail("internal", "response too large")) : encoded;
};

export const runNativeHost = (
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
	handler: (msg: unknown) => Promise<unknown>,
): Promise<void> =>
	new Promise((resolve, reject) => {
		let queue: Promise<void> = Promise.resolve();
		const respond = (msg: unknown) => {
			queue = queue.then(async () => {
				const response = await handler(msg).catch((error: Error) => fail("internal", error.message));
				output.write(encodeCapped(response));
			});
		};
		const decode = createDecoder(respond);
		input.on("data", (chunk: Buffer | string) => decode(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		input.on("error", reject);
		input.on("end", () => queue.then(resolve, reject));
	});

const realpathOrSelf = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

export const currentProfileFromParent = (home: string, ppid: number = process.ppid): string | null => {
	let args: string;
	try {
		args = execFileSync("ps", ["-o", "args=", "-p", String(ppid)], { encoding: "utf8" });
	} catch {
		return null;
	}
	const dir = userDataDirFromArgs(args);
	if (dir === null) return null;
	const parentDir = realpathOrSelf(dir);
	try {
		const match = readProfiles(home).find((profile) => realpathOrSelf(userDataDir(home, profile.name)) === parentDir);
		return match?.name ?? null;
	} catch {
		return null;
	}
};

export const createNativeHandler = (origin: string | undefined, ctx: Context): ((msg: unknown) => Promise<unknown>) =>
	origin === EXPECTED_ORIGIN
		? (msg) => handleNative(msg, ctx)
		: async () => fail("unauthorized", "Caller origin is not allowed");
