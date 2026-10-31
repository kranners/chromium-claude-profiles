import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import type { Context } from "../src/protocol.ts";

export const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ccp-"));
	after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

export const tempContext = (env: NodeJS.ProcessEnv = {}): Context => {
	const root = tempDir();
	const home = join(root, "home");
	return {
		home,
		env: {
			HOME: join(root, "user"),
			CCP_HOME: home,
			CCP_CHROMIUM: join(root, "no-chromium"),
			CCP_CLAUDE_EXT_SOURCE: join(root, "no-source"),
			...env,
		},
		current: null,
	};
};
