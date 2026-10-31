import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromiumDefaultHostsDir, cliPath, shellQuote, wrapperPath } from "./paths.ts";

export const HOST_NAME = "engineer.cute.claude_profiles";
export const EXTENSION_ID = "bkgjdpakjigjgdggfcckikppbjjcdkim";
export const CLAUDE_CODE_HOST_NAME = "com.anthropic.claude_code_browser_extension";

export const buildHostManifest = (wrapperPath: string) => ({
	name: HOST_NAME,
	description: "Claude Profiles launcher",
	path: wrapperPath,
	type: "stdio",
	allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
});

export const claudeCodeManifestSource = (env: NodeJS.ProcessEnv = process.env): string =>
	join(chromiumDefaultHostsDir(env), `${CLAUDE_CODE_HOST_NAME}.json`);

export const writeWrapper = (home: string): string => {
	const path = wrapperPath(home);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`#!/bin/sh\nexec ${shellQuote(process.execPath)} --disable-warning=ExperimentalWarning ${shellQuote(cliPath)} native-host "$@"\n`,
		{ mode: 0o755 },
	);
	chmodSync(path, 0o755);
	return path;
};

export const writeOurManifest = (home: string, nmhDir: string): void => {
	mkdirSync(nmhDir, { recursive: true });
	writeFileSync(join(nmhDir, `${HOST_NAME}.json`), `${JSON.stringify(buildHostManifest(wrapperPath(home)), null, 2)}\n`);
};

export const installHostInto = (
	home: string,
	nmhDir: string,
	claudeCodeManifest: string = claudeCodeManifestSource(),
): void => {
	writeOurManifest(home, nmhDir);
	if (existsSync(claudeCodeManifest)) {
		copyFileSync(claudeCodeManifest, join(nmhDir, `${CLAUDE_CODE_HOST_NAME}.json`));
	}
};
