import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const DEFAULT_PORT = 47321;
export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const cliPath = join(repoRoot, "launcher", "src", "cli.ts");

const userHome = (env: NodeJS.ProcessEnv): string => env.HOME || homedir();

export const chromiumSupportDir = (env: NodeJS.ProcessEnv): string =>
	join(userHome(env), "Library", "Application Support", "Chromium");

export const chromiumDefaultHostsDir = (env: NodeJS.ProcessEnv): string =>
	join(chromiumSupportDir(env), "NativeMessagingHosts");

export const ccpHome = (env: NodeJS.ProcessEnv): string =>
	(env.CCP_HOME ? resolve(env.CCP_HOME) : join(userHome(env), ".config", "chromium-claude-profiles"));

export const chromiumBinary = (env: NodeJS.ProcessEnv): string =>
	env.CCP_CHROMIUM || "/Applications/Chromium.app/Contents/MacOS/Chromium";

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
export const vendorDir = (home: string): string => join(home, "vendor", "claude-in-chrome");
export const userDataDir = (home: string, name: string): string => join(home, "profiles", name);
export const hostsDir = (home: string, name: string): string =>
	join(userDataDir(home, name), "NativeMessagingHosts");

export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
