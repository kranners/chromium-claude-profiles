import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { installHostInto, writeOurManifest, writeWrapper } from "./hostManifest.ts";
import { claudeCodeManifestSource } from "./hostManifest.ts";
import { createNativeHandler, currentProfileFromParent, runNativeHost } from "./nativeHost.ts";
import { DEFAULT_PORT, ccpHome, chromiumDefaultHostsDir, hostsDir, shellQuote, tokenFile } from "./paths.ts";
import { handle } from "./protocol.ts";
import type { ProfileView, Result } from "./protocol.ts";
import { createApiServer, listen } from "./server.ts";
import { ensureHome, readProfiles, SCHEMA_VERSION } from "./store.ts";
import { ensureToken } from "./token.ts";

const USAGE = `usage:
  ccp list [--json]
  ccp add <name> [--email E] [--config-dir D] [--json]
  ccp remove <name> [--keep-data] [--json]
  ccp launch <name> [--url U] [--json]
  ccp status [<name>] [--json]
  ccp env <name>
  ccp serve [--port N]
  ccp install-host [--chromium-default]
  ccp native-host <origin>
`;

class UsageError extends Error {}

type Options = NonNullable<ParseArgsConfig["options"]>;

const JSON_FLAG: Options = { json: { type: "boolean" } };

const parse = (args: string[], options: Options, positionals: { min: number; max: number }) => {
	let parsed;
	try {
		parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
	} catch (error) {
		throw new UsageError((error as Error).message);
	}
	if (parsed.positionals.length < positionals.min || parsed.positionals.length > positionals.max) {
		throw new UsageError("wrong number of arguments");
	}
	return { values: parsed.values as Record<string, string | boolean | undefined>, positionals: parsed.positionals };
};

const context = () => ({ home: ccpHome(process.env), env: process.env, current: null });

const formatTable = (profiles: ProfileView[]): string => {
	if (profiles.length === 0) return "no profiles\n";
	const rows = profiles.map((profile) => [
		profile.name,
		profile.running ? "●" : "○",
		profile.email ?? "-",
		profile.pid === null ? "-" : String(profile.pid),
	]);
	const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => row[column].length)));
	return rows.map((row) => row.map((cell, column) => (column < 3 ? cell.padEnd(widths[column]) : cell)).join("  ")).join("\n") + "\n";
};

const report = (result: Result<object>, json: boolean, human: (result: Record<string, unknown>) => string): number => {
	if (json) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} else if (result.ok) {
		process.stdout.write(human(result as Record<string, unknown>));
	} else {
		process.stderr.write(`ccp: ${result.error.message}\n`);
	}
	return result.ok ? 0 : 1;
};

const profileLine = (result: Record<string, unknown>) => formatTable([result.profile as ProfileView]);

const list = async (args: string[]): Promise<number> => {
	const { values } = parse(args, JSON_FLAG, { min: 0, max: 0 });
	const result = await handle({ type: "profiles.list" }, context());
	const output = result.ok ? { schemaVersion: SCHEMA_VERSION, ...result } : result;
	return report(output, values.json === true, (ok) => formatTable(ok.profiles as ProfileView[]));
};

const add = async (args: string[]): Promise<number> => {
	const { values, positionals } = parse(
		args,
		{ ...JSON_FLAG, email: { type: "string" }, "config-dir": { type: "string" } },
		{ min: 1, max: 1 },
	);
	const result = await handle(
		{ type: "profiles.add", name: positionals[0], email: values.email, configDir: values["config-dir"] },
		context(),
	);
	return report(result, values.json === true, profileLine);
};

const remove = async (args: string[]): Promise<number> => {
	const { values, positionals } = parse(args, { ...JSON_FLAG, "keep-data": { type: "boolean" } }, { min: 1, max: 1 });
	const result = await handle(
		{ type: "profiles.remove", name: positionals[0], keepData: values["keep-data"] === true },
		context(),
	);
	return report(result, values.json === true, () => `removed ${positionals[0]}\n`);
};

const launch = async (args: string[]): Promise<number> => {
	const { values, positionals } = parse(args, { ...JSON_FLAG, url: { type: "string" } }, { min: 1, max: 1 });
	const result = await handle({ type: "profiles.launch", name: positionals[0], url: values.url }, context());
	return report(result, values.json === true, profileLine);
};

const status = async (args: string[]): Promise<number> => {
	const { values, positionals } = parse(args, JSON_FLAG, { min: 0, max: 1 });
	if (positionals.length === 0) return list(args);
	const result = await handle({ type: "profiles.status", name: positionals[0] }, context());
	return report(result, values.json === true, profileLine);
};

const env = async (args: string[]): Promise<number> => {
	const { positionals } = parse(args, {}, { min: 1, max: 1 });
	const result = await handle({ type: "profiles.env", name: positionals[0] }, context());
	return report(result, false, (ok) => {
		const { CLAUDE_CONFIG_DIR } = ok.env as { CLAUDE_CONFIG_DIR: string };
		return `unset CLAUDE_CODE_OAUTH_TOKEN; export CLAUDE_CONFIG_DIR=${shellQuote(CLAUDE_CONFIG_DIR)}\n`;
	});
};

const parsePort = (value: string | undefined): number => {
	const port = Number(value);
	if (!/^[0-9]+$/.test(value ?? "") || port > 65535) throw new UsageError(`invalid port: ${value}`);
	return port;
};

const serve = async (args: string[]): Promise<number> => {
	const { values } = parse(args, { port: { type: "string" } }, { min: 0, max: 0 });
	const portText = (values.port as string | undefined) ?? process.env.CCP_PORT;
	const port = portText === undefined ? DEFAULT_PORT : parsePort(portText);
	const home = ccpHome(process.env);
	const token = ensureToken(home);
	const server = createApiServer({ home, env: process.env, token });
	const bound = await listen(server, port);
	process.stderr.write(`ccp serving on http://127.0.0.1:${bound} (token in ${tokenFile(home)})\n`);
	await new Promise<void>((resolve) => {
		const stop = () => server.close(() => resolve());
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
	return 0;
};

const installHost = async (args: string[]): Promise<number> => {
	const { values } = parse(args, { "chromium-default": { type: "boolean" } }, { min: 0, max: 0 });
	const home = ccpHome(process.env);
	ensureHome(home);
	writeWrapper(home);
	const installed = readProfiles(home).map((profile) => {
		const dir = hostsDir(home, profile.name);
		installHostInto(home, dir, claudeCodeManifestSource(process.env));
		return dir;
	});
	if (values["chromium-default"] === true) {
		const dir = chromiumDefaultHostsDir(process.env);
		writeOurManifest(home, dir);
		installed.push(dir);
	}
	process.stdout.write(installed.map((dir) => `installed ${dir}\n`).join(""));
	return 0;
};

const nativeHost = async (args: string[]): Promise<number> => {
	const home = ccpHome(process.env);
	const ctx = { home, env: process.env, current: currentProfileFromParent(home) };
	await runNativeHost(process.stdin, process.stdout, createNativeHandler(args[0], ctx));
	return 0;
};

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
	list,
	add,
	remove,
	launch,
	status,
	env,
	serve,
	"install-host": installHost,
	"native-host": nativeHost,
};

const main = async (argv: string[]): Promise<number> => {
	const [command, ...args] = argv;
	const run = command === undefined ? undefined : COMMANDS[command];
	if (!run) {
		process.stderr.write(USAGE);
		return 2;
	}
	try {
		return await run(args);
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`ccp: ${error.message}\n${USAGE}`);
			return 2;
		}
		process.stderr.write(`ccp: ${(error as Error).message}\n`);
		return 1;
	}
};

process.exitCode = await main(process.argv.slice(2));
