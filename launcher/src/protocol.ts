import { listAccounts, migrate, openAccount, openFor, resolveAccount, writeAccountsStatus } from "./accounts.ts";
import { callBridge, MAIN_BROWSER } from "./bridge.ts";
import { isSafeUrl, prepareProfileHosts } from "./chromium.ts";
import { bridgeSocket } from "./paths.ts";
import { VERSION } from "./paths.ts";
import { normaliseEmails, reloginStatus, startRelogin, stopRelogin } from "./relogin.ts";
import { addProfile, ensureHome, fail, findProfile, isValidName, readProfiles, removeProfile, viewOf } from "./store.ts";

export type Profile = { name: string; email: string | null; configDir: string | null; createdAt: string };
export type ProfileView = Profile & { userDataDir: string; running: boolean; pid: number | null };
export type ErrorCode =
	| "invalid_request"
	| "not_found"
	| "already_exists"
	| "running"
	| "unauthorized"
	| "chromium_not_found"
	| "unsupported"
	| "native_host_unavailable"
	| "browser_unavailable"
	| "session_expired"
	| "internal";
export type Failure = { ok: false; error: { code: ErrorCode; message: string } };
export type Result<T extends object> = ({ ok: true } & T) | Failure;

export type Context = { home: string; env: NodeJS.ProcessEnv; current: string | null };

export const NATIVE_HOST_TYPES: readonly string[] = [
	"ping",
	"profiles.list",
	"profiles.status",
	"accounts.report",
	"relogin.start",
	"relogin.status",
	"relogin.stop",
];

type Request = { type: string; [param: string]: unknown };

const isRequest = (value: unknown): value is Request =>
	typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Request).type === "string";

const withProfile = <T extends object>(
	ctx: Context,
	name: unknown,
	use: (profile: Profile) => Result<T> | Promise<Result<T>>,
): Result<T> | Promise<Result<T>> => {
	if (!isValidName(name)) return fail("invalid_request", "Invalid profile name");
	const profile = findProfile(ctx.home, name);
	return profile ? use(profile) : fail("not_found", `No profile named ${name}`);
};

const dispatch = (req: Request, ctx: Context): Result<object> | Promise<Result<object>> => {
	switch (req.type) {
		case "ping":
			return { ok: true, version: VERSION };
		case "profiles.list":
			return {
				ok: true,
				profiles: readProfiles(ctx.home).map((profile) => viewOf(ctx.home, profile)),
				current: ctx.current,
			};
		case "profiles.status":
			return withProfile(ctx, req.name, (profile) => ({ ok: true, profile: viewOf(ctx.home, profile) }));
		case "profiles.add": {
			ensureHome(ctx.home);
			const added = addProfile(ctx.home, { name: req.name, email: req.email, configDir: req.configDir });
			if (!added.ok) return added;
			prepareProfileHosts(ctx.home, added.profile.name, ctx.env);
			return { ok: true, profile: viewOf(ctx.home, added.profile) };
		}
		case "profiles.remove":
			if (req.keepData !== undefined && typeof req.keepData !== "boolean") {
				return fail("invalid_request", "keepData must be a boolean");
			}
			return removeProfile(ctx.home, req.name, req.keepData === true);
		case "profiles.launch":
		case "accounts.open":
			if (req.url !== undefined && !isSafeUrl(req.url)) {
				return fail("invalid_request", "url must be an http or https URL");
			}
			return openAccount(ctx, req.name, req.url);
		case "accounts.list":
			return listAccounts(ctx).then((listed) => ({ ok: true, browser: { connected: listed.connected, updatedAt: listed.updatedAt }, active: listed.active, accounts: listed.accounts }));
		case "accounts.status":
			return listAccounts(ctx, { check: true }).then((listed) => {
				const base = { browser: { connected: listed.connected, updatedAt: listed.updatedAt }, active: listed.active };
				if (req.name === undefined) return { ok: true, ...base, accounts: listed.accounts };
				const account = typeof req.name === "string" ? resolveAccount(listed.accounts, req.name) : null;
				return account ? { ok: true, ...base, account } : fail("not_found", `No saved account matches ${String(req.name)}`);
			});
		case "accounts.openFor":
			return openFor(ctx, req.url);
		case "accounts.save":
		case "accounts.signIn":
			return req.type === "accounts.save" && typeof req.label !== "string"
				? fail("invalid_request", "Name the account")
				: callBridge(bridgeSocket(ctx.home, MAIN_BROWSER), { type: req.type, label: req.label }, 60_000);
		case "migrate":
			return migrate(ctx);
		case "profiles.env":
			return withProfile(ctx, req.name, (profile) =>
				profile.configDir === null
					? fail("invalid_request", `Profile ${profile.name} has no configDir`)
					: { ok: true, env: { CLAUDE_CONFIG_DIR: profile.configDir }, unset: ["CLAUDE_CODE_OAUTH_TOKEN"] },
			);
		default:
			return fail("unsupported", `Unsupported request type: ${req.type}`);
	}
};

const dispatchNative = (req: Request, ctx: Context): Result<object> | Promise<Result<object>> => {
	if (req.type === "accounts.report") {
		return ctx.current === null ? writeAccountsStatus(ctx.home, req.accounts) : { ok: true, ignored: true };
	}
	if (req.type === "relogin.status") return reloginStatus(ctx);
	if (req.type === "relogin.stop") return stopRelogin(ctx);
	if (req.type !== "relogin.start") return dispatch(req, ctx);
	const emails = normaliseEmails(req.emails);
	return emails === null ? fail("invalid_request", "emails must be 1 to 20 email addresses") : startRelogin(ctx, emails);
};

const run = async (
	req: unknown,
	ctx: Context,
	route: (req: Request, ctx: Context) => Result<object> | Promise<Result<object>>,
): Promise<Result<object>> => {
	if (!isRequest(req)) return fail("invalid_request", "Request must be an object with a string type");
	try {
		return await route(req, ctx);
	} catch (error) {
		process.stderr.write(`ccp: ${req.type} failed: ${(error as Error).message}\n`);
		return fail("internal", (error as Error).message);
	}
};

export const handle = (req: unknown, ctx: Context): Promise<Result<object>> => run(req, ctx, dispatch);

export const handleNative = (req: unknown, ctx: Context): Promise<Result<object>> => {
	if (isRequest(req) && !NATIVE_HOST_TYPES.includes(req.type)) {
		return Promise.resolve(fail("unsupported", `${req.type} is not available over the native host`));
	}
	return run(req, ctx, dispatchNative);
};
