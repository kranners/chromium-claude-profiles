import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ClaudeInChromeIdentity = { accountUuid: string; bridgeDeviceId: string };

const CLAUDE_IN_CHROME_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

const lastUuidAfter = (text: string, key: string): string | null =>
	[...text.matchAll(new RegExp(`${key}[\\s\\S]{1,4}?"([0-9a-f-]{36})"`, "g"))].at(-1)?.[1] ?? null;

export const parseIdentity = (text: string): ClaudeInChromeIdentity | null => {
	const accountUuid = lastUuidAfter(text, "accountUuid");
	const bridgeDeviceId = lastUuidAfter(text, "bridgeDeviceId");
	return accountUuid && bridgeDeviceId ? { accountUuid, bridgeDeviceId } : null;
};

export const claudeInChromeStorageDir = (userDataDir: string): string =>
	join(userDataDir, "Default", "Local Extension Settings", CLAUDE_IN_CHROME_ID);

const readLatin1 = (path: string): string => {
	try {
		return readFileSync(path).toString("latin1");
	} catch {
		return "";
	}
};

export const readClaudeInChromeIdentity = (userDataDir: string): ClaudeInChromeIdentity | null => {
	const dir = claudeInChromeStorageDir(userDataDir);
	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return null;
	}
	const newestLast = [...names.filter((name) => name.endsWith(".ldb")), ...names.filter((name) => name.endsWith(".log"))];
	return parseIdentity(newestLast.map((name) => readLatin1(join(dir, name))).join("\n"));
};
