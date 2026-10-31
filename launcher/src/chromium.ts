import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { vendorClaudeExtension, findClaudeExtension } from "./claudeExt.ts";
import { installHostInto, claudeCodeManifestSource, writeWrapper } from "./hostManifest.ts";
import { chromiumBinary, claudeExtensionSource, extraArgs, hostsDir, ourExtensionDir, userDataDir } from "./paths.ts";
import type { Profile, ProfileView, Result } from "./protocol.ts";
import { isRunning } from "./running.ts";
import { fail, viewOf } from "./store.ts";

export const buildLaunchArgs = ({
	userDataDir,
	extensionDirs,
	url,
	extraArgs,
}: {
	userDataDir: string;
	extensionDirs: string[];
	url?: string | null;
	extraArgs?: string[];
}): string[] => [
	`--user-data-dir=${userDataDir}`,
	"--profile-directory=Default",
	"--no-first-run",
	"--no-default-browser-check",
	`--load-extension=${extensionDirs.join(",")}`,
	...(extraArgs ?? []),
	...(url ? [url] : []),
];

export const isSafeUrl = (url: unknown): url is string => {
	if (typeof url !== "string" || url.startsWith("-")) return false;
	try {
		const { protocol } = new URL(url);
		return protocol === "https:" || protocol === "http:";
	} catch {
		return false;
	}
};

const isExecutable = (path: string): boolean => {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

const START_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

const waitUntilRunning = async (dir: string): Promise<boolean> => {
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (isRunning(dir).running) return true;
		await delay(POLL_INTERVAL_MS);
	}
	return isRunning(dir).running;
};

export const prepareProfileHosts = (home: string, name: string, env: NodeJS.ProcessEnv): void => {
	writeWrapper(home);
	installHostInto(home, hostsDir(home, name), claudeCodeManifestSource(env));
};

export const launchProfile = async (
	home: string,
	profile: Profile,
	url: string | null,
	env: NodeJS.ProcessEnv,
): Promise<Result<{ profile: ProfileView; alreadyRunning: boolean; claudeInChromeVersion: string | null }>> => {
	const binary = chromiumBinary(env);
	if (!isExecutable(binary)) return fail("chromium_not_found", `Chromium not found at ${binary}`);
	const dir = userDataDir(home, profile.name);
	const alreadyRunning = isRunning(dir).running;
	const source = claudeExtensionSource(env);
	const claudeExtension = findClaudeExtension(source);
	const vendored = claudeExtension ? vendorClaudeExtension(home, source) : null;
	prepareProfileHosts(home, profile.name, env);
	const args = buildLaunchArgs({
		userDataDir: dir,
		extensionDirs: [...(vendored ? [vendored] : []), ourExtensionDir(env)],
		url,
		extraArgs: extraArgs(env),
	});
	const child = spawn(binary, args, { detached: true, stdio: "ignore" });
	child.on("error", (error) => process.stderr.write(`ccp: Chromium failed to spawn: ${error.message}\n`));
	child.unref();
	if (!(await waitUntilRunning(dir))) return fail("internal", "Chromium did not start");
	return {
		ok: true,
		profile: viewOf(home, profile),
		alreadyRunning,
		claudeInChromeVersion: vendored ? (claudeExtension?.version ?? null) : null,
	};
};
