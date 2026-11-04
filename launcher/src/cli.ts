import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { installHostInto, writeOurManifest, writeWrapper } from "./hostManifest.ts";
import { claudeCodeManifestSource } from "./hostManifest.ts";
import { createNativeHandler, currentProfileFromParent, encodeMessage, runNativeHost } from "./nativeHost.ts";
import { DEFAULT_PORT, ccpHome, chromiumDefaultHostsDir, hostsDir, shellQuote, tokenFile } from "./paths.ts";
import { handle } from "./protocol.ts";
import type { AccountView, MigrationRow } from "./accounts.ts";
import type { ProfileView, Result } from "./protocol.ts";
import { createApiServer, listen } from "./server.ts";
import { ensureHome, readProfiles, SCHEMA_VERSION } from "./store.ts";
import { ensureToken } from "./token.ts";

const USAGE = `usage:
  ccp list [--json]
  ccp status [<account>] [--json]
  ccp launch <account> [--url U] [--json]
  ccp switch <account> [--json]
  ccp open-for <claude.ai url> [--json]
  ccp migrate [--json]
  ccp add <name> [--email E] [--config-dir D] [--json]      (old per-account profiles)
  ccp remove <name> [--keep-data] [--json]                  (old per-account profiles)
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

const STATE_TEXT: Record<AccountView["state"], string> = {
	"signed-in": "signed in",
	expiring: "signed in, expires soon",
	"signed-out": "SIGNED OUT",
	unknown: "couldn't check",
};

const expiryText = (view: AccountView): string =>
	view.sessionExpiresAt === null ? "-" : `expires ${view.sessionExpiresAt.slice(0, 10)}`;

const formatAccounts = (accounts: AccountView[], connected: boolean): string => {
	const rows = accounts.map((view) => [view.active ? "●" : "○", view.name, view.email ?? view.label, STATE_TEXT[view.state], expiryText(view)]);
	const widths = [0, 1, 2, 3].map((column) => Math.max(0, ...rows.map((row) => row[column].length)));
	const table = rows.map((row) => row.map((cell, column) => (column < 4 ? cell.padEnd(widths[column]) : cell)).join("  ")).join("\n");
	const lines = [
		...(accounts.length ? [table] : ["no saved accounts; save them in the Claude Profiles popup"]),
		...(connected ? [] : ["(main Chromium not connected; showing the last saved status)"]),
		...(accounts.some((view) => view.state === "signed-out")
			? ["Signed out accounts need one sign-in: Claude Profiles popup → Sign back in to signed-out accounts, or sign in and Save current."]
			: []),
	];
	return `${lines.join("\n")}\n`;
};

const listed = (ok: Record<string, unknown>) =>
	formatAccounts(ok.accounts as AccountView[], (ok.browser as { connected: boolean }).connected);

const withLegacy = (result: Result<object>): Result<object> => {
	if (!result.ok) return result;
	const home = ccpHome(process.env);
	const accounts = (result as unknown as { accounts: AccountView[] }).accounts;
	const connected = (result as unknown as { browser: { connected: boolean } }).browser.connected;
	return {
		schemaVersion: SCHEMA_VERSION,
		...result,
		profiles: accounts.map((view) => ({ name: view.name, email: view.email, running: connected, state: view.state })),
		legacyProfiles: readProfiles(home).map((profile) => profile.name),
	} as Result<object>;
};

const list = async (args: string[]): Promise<number> => {
	const { values } = parse(args, JSON_FLAG, { min: 0, max: 0 });
	const result = withLegacy(await handle({ type: "accounts.list" }, context()));
	return report(result, values.json === true, listed);
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

const accountLine = (ok: Record<string, unknown>) => formatAccounts([ok.account as AccountView], true);

const launch = async (args: string[]): Promise<number> => {
	const { values, positionals } = parse(args, { ...JSON_FLAG, url: { type: "string" } }, { min: 1, max: 1 });
	const result = await handle({ type: "accounts.open", name: positionals[0], url: values.url }, context());
	return report(result, values.json === true, (ok) => {
		const account = ok.account as AccountView;
		return `${ok.switched ? "switched to" : "already on"} ${account.email ?? account.label}${values.url ? `, opened ${values.url}` : ""}\n`;
	});
};

const switchCommand = async (args: string[]): Promise<number> => {
	const { values, positionals } = parse(args, JSON_FLAG, { min: 1, max: 1 });
	return launch([positionals[0], ...(values.json === true ? ["--json"] : [])]);
};

const status = async (args: string[]): Promise<number> => {
	const { values, positionals } = parse(args, JSON_FLAG, { min: 0, max: 1 });
	const result = await handle({ type: "accounts.status", name: positionals[0] }, context());
	if (positionals.length === 0) return report(withLegacy(result), values.json === true, listed);
	return report(result, values.json === true, accountLine);
};

const openForCommand = async (args: string[]): Promise<number> => {
	const { values, positionals } = parse(args, JSON_FLAG, { min: 1, max: 1 });
	const result = await handle({ type: "accounts.openFor", url: positionals[0] }, context());
	return report(result, values.json === true, (ok) => {
		const account = ok.account as AccountView | null;
		return `opened in ${account?.email ?? String(ok.label)}\n`;
	});
};

const MIGRATION_TEXT: Record<MigrationRow["outcome"], string> = {
	imported: "session moved into your main Chromium",
	"already-signed-in": "main Chromium already signed in; left as is",
	"signed-out": "signed out; sign in once in your main Chromium",
	unreachable: "could not read it",
};

const migrateCommand = async (args: string[]): Promise<number> => {
	const { values } = parse(args, JSON_FLAG, { min: 0, max: 0 });
	const result = await handle({ type: "migrate" }, context());
	return report(result, values.json === true, (ok) => {
		const rows = ok.profiles as MigrationRow[];
		const needSignIn = ok.needSignIn as string[];
		return [
			...rows.map((row) => `${row.profile} (${row.email ?? "no email"}): ${MIGRATION_TEXT[row.outcome]}${row.reason ? ` (${row.reason})` : ""}`),
			...(rows.length ? [] : ["no old profiles to migrate"]),
			needSignIn.length ? `Needs one sign-in in your main Chromium: ${needSignIn.join(", ")}` : "Every saved account is signed in.",
			"Old profile folders are left in place; delete them yourself once you are happy.",
		].join("\n") + "\n";
	});
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
	const handler = createNativeHandler(args[0], ctx, (msg) => process.stdout.write(encodeMessage(msg)));
	await runNativeHost(process.stdin, process.stdout, handler);
	await handler.bridge()?.close();
	return 0;
};

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
	list,
	add,
	remove,
	launch,
	switch: switchCommand,
	status,
	"open-for": openForCommand,
	migrate: migrateCommand,
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
