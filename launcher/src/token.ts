import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { tokenFile } from "./paths.ts";
import { ensureHome } from "./store.ts";

const TOKEN = /^[0-9a-f]{64}$/;

export const ensureToken = (home: string): string => {
	ensureHome(home);
	const path = tokenFile(home);
	try {
		const existing = readFileSync(path, "utf8").trim();
		if (TOKEN.test(existing)) {
			chmodSync(path, 0o600);
			return existing;
		}
	} catch {}
	const token = randomBytes(32).toString("hex");
	writeFileSync(path, `${token}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return token;
};

export const tokensMatch = (expected: string, presented: string): boolean => {
	const left = Buffer.from(expected);
	const right = Buffer.from(presented);
	return left.length === right.length && timingSafeEqual(left, right);
};
