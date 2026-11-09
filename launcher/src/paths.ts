import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const DEFAULT_PORT = 47321;
export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const BROWSERS = ["chromium", "chrome", "brave"] as const;
export type Browser = (typeof BROWSERS)[number];
export type Platform = "darwin" | "linux";

export const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const cliPath = join(repoRoot, "launcher", "src", "cli.ts");

const userHome = (env: NodeJS.ProcessEnv): string => env.HOME || homedir();

export const platformOf = (env: NodeJS.ProcessEnv): Platform =>
	(env.CCP_PLATFORM || process.platform) === "darwin" ? "darwin" : "linux";

export const isBrowser = (value: unknown): value is Browser => BROWSERS.includes(value as Browser);

export const ccpHome = (env: NodeJS.ProcessEnv): string =>
	(env.CCP_HOME ? resolve(env.CCP_HOME) : join(userHome(env), ".config", "chromium-claude-profiles"));

export const browserFile = (home: string): string => join(home, "browser");

// The browser ccp drives: CCP_BROWSER, else what `ccp install-host --browser` saved, else Chromium.
export const browserOf = (env: NodeJS.ProcessEnv): Browser => {
	if (isBrowser(env.CCP_BROWSER)) return env.CCP_BROWSER;
	try {
		const saved = readFileSync(browserFile(ccpHome(env)), "utf8").trim();
		if (isBrowser(saved)) return saved;
	} catch {
		// no saved choice
	}
	return "chromium";
};

const SUPPORT_DIRS: Record<Platform, Record<Browser, string[]>> = {
	darwin: {
		chromium: ["Library", "Application Support", "Chromium"],
		chrome: ["Library", "Application Support", "Google", "Chrome"],
		brave: ["Library", "Application Support", "BraveSoftware", "Brave-Browser"],
	},
	linux: {
		chromium: [".config", "chromium"],
		chrome: [".config", "google-chrome"],
		brave: [".config", "BraveSoftware", "Brave-Browser"],
	},
};

export const chromiumSupportDir = (env: NodeJS.ProcessEnv): string =>
	join(userHome(env), ...SUPPORT_DIRS[platformOf(env)][browserOf(env)]);

export const chromiumDefaultHostsDir = (env: NodeJS.ProcessEnv): string =>
	join(chromiumSupportDir(env), "NativeMessagingHosts");

const MAC_BINARIES: Record<Browser, string> = {
	chromium: "/Applications/Chromium.app/Contents/MacOS/Chromium",
	chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
};

const LINUX_NAMES: Record<Browser, string[]> = {
	chromium: ["chromium", "chromium-browser"],
	chrome: ["google-chrome-stable", "google-chrome"],
	brave: ["brave-browser", "brave"],
};

const executable = (path: string): boolean => {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

const onPath = (names: string[], env: NodeJS.ProcessEnv): string | null => {
	for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
		for (const name of names) if (executable(join(dir, name))) return join(dir, name);
	}
	return null;
};

export const chromiumBinary = (env: NodeJS.ProcessEnv): string => {
	if (env.CCP_CHROMIUM) return env.CCP_CHROMIUM;
	const browser = browserOf(env);
	if (platformOf(env) === "darwin") return MAC_BINARIES[browser];
	return onPath(LINUX_NAMES[browser], env) ?? LINUX_NAMES[browser][0];
};

export const claudeExtensionSource = (env: NodeJS.ProcessEnv): string =>
	env.CCP_CLAUDE_EXT_SOURCE ||
	join(chromiumSupportDir(env), "Default", "Extensions", "fcoeoabgfenejglbffodgkkbkcdhcgfn");

export const ourExtensionDir = (env: NodeJS.ProcessEnv): string =>
	env.CCP_EXTENSION_DIR || join(repoRoot, "extension");

export const extraArgs = (env: NodeJS.ProcessEnv): string[] =>
	(env.CCP_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean);

export const profilesFile = (home: string): string => join(home, "profiles.json");
export const tokenFile = (home: string): string => join(home, "token");
export const wrapperPath = (home: string): string => join(home, "bin", "native-host");
export const nodeFile = (home: string): string => join(home, "node");
export const vendorDir = (home: string): string => join(home, "vendor", "claude-in-chrome");
export const userDataDir = (home: string, name: string): string => join(home, "profiles", name);
export const hostsDir = (home: string, name: string): string =>
	join(userDataDir(home, name), "NativeMessagingHosts");

export const runDir = (home: string): string => join(home, "run");
export const bridgeSocket = (home: string, browser: string): string => join(runDir(home), `${browser}.sock`);
export const accountsStatusFile = (home: string): string => join(home, "accounts.json");

export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
