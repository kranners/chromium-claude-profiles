import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { callBridge, MAIN_BROWSER } from "./bridge.ts";
import { isSafeUrl, launchProfile } from "./chromium.ts";
import { accountsStatusFile, bridgeSocket, chromiumBinary, chromiumSupportDir, userDataDir } from "./paths.ts";
import type { Context, Profile, Result } from "./protocol.ts";
import { isRunning, pidAlive } from "./running.ts";
import { ensureHome, fail, readProfiles } from "./store.ts";

export type AccountStatus = "ok" | "revoked" | "unknown" | null;
export type AccountState = "signed-in" | "expiring" | "signed-out" | "unknown";
export type AccountSummary = {
	label: string;
	email: string | null;
	status: AccountStatus;
	checkedAt: string | null;
	sessionExpiresAt: string | null;
};
export type AccountView = AccountSummary & { name: string; state: AccountState; active: boolean };

export const EXPIRING_MS = 3 * 24 * 60 * 60 * 1000;
const STATUSES = new Set(["ok", "revoked", "unknown"]);
const LABEL = /^[A-Za-z0-9 ._@-]{1,64}$/;
const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,128}$/;
const BROWSER_START_MS = 20_000;
const PROFILE_START_MS = 30_000;
const OPEN_FOR_TIMEOUT_MS = 4 * 60_000;

const mainSocket = (home: string) => bridgeSocket(home, MAIN_BROWSER);
export const profileSocket = (home: string, name: string) => bridgeSocket(home, `profile-${name}`);

const isIsoDate = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

export const toSummary = (value: unknown): AccountSummary | null => {
	if (typeof value !== "object" || value === null) return null;
	const entry = value as Record<string, unknown>;
	if (typeof entry.label !== "string" || !LABEL.test(entry.label)) return null;
	return {
		label: entry.label,
		email: typeof entry.email === "string" && EMAIL.test(entry.email) ? entry.email : null,
		status: typeof entry.status === "string" && STATUSES.has(entry.status) ? (entry.status as AccountStatus) : null,
		checkedAt: isIsoDate(entry.checkedAt) ? entry.checkedAt : null,
		sessionExpiresAt: isIsoDate(entry.sessionExpiresAt) ? entry.sessionExpiresAt : null,
	};
};

export const accountState = (summary: AccountSummary, now = Date.now()): AccountState => {
	const expiresAt = summary.sessionExpiresAt === null ? null : Date.parse(summary.sessionExpiresAt);
	if (summary.status === "revoked" || (expiresAt !== null && expiresAt <= now)) return "signed-out";
	if (summary.status !== "ok") return "unknown";
	return expiresAt !== null && expiresAt - now < EXPIRING_MS ? "expiring" : "signed-in";
};

export const slug = (label: string): string =>
	label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/, "") || "account";

export const toViews = (summaries: AccountSummary[], active: string | null, now = Date.now()): AccountView[] => {
	const taken = new Set<string>();
	return [...summaries]
		.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
		.map((summary) => {
			const base = slug(summary.label);
			let name = base;
			for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 29)}-${n}`;
			taken.add(name);
			return { name, ...summary, state: accountState(summary, now), active: summary.label === active };
		});
};

export const resolveAccount = (views: AccountView[], ref: string): AccountView | null => {
	const lower = ref.toLowerCase();
	return (
		views.find((view) => view.label === ref) ??
		views.find((view) => view.name === lower) ??
		views.find((view) => view.email?.toLowerCase() === lower) ??
		views.find((view) => view.label.toLowerCase() === lower) ??
		null
	);
};

const legacyEmail = (home: string, ref: string): string | null =>
	readProfiles(home).find((profile) => profile.name === ref)?.email ?? null;

export const writeAccountsStatus = (home: string, accounts: unknown): Result<{}> => {
	if (!Array.isArray(accounts) || accounts.length > 100) return fail("invalid_request", "accounts must be a list of at most 100");
	const summaries = accounts.map(toSummary);
	if (summaries.includes(null)) return fail("invalid_request", "Malformed account summary");
	ensureHome(home);
	const target = accountsStatusFile(home);
	const temporary = `${target}.${process.pid}.tmp`;
	const body = { schemaVersion: 1, updatedAt: new Date().toISOString(), accounts: toViews(summaries as AccountSummary[], null).map(({ active: _a, ...view }) => view) };
	writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, target);
	return { ok: true };
};

export const readAccountsStatus = (home: string): { updatedAt: string | null; accounts: AccountSummary[] } => {
	try {
		const parsed = JSON.parse(readFileSync(accountsStatusFile(home), "utf8"));
		const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts.map(toSummary).filter(Boolean) : [];
		return { updatedAt: isIsoDate(parsed?.updatedAt) ? parsed.updatedAt : null, accounts };
	} catch {
		return { updatedAt: null, accounts: [] };
	}
};

type Listed = { connected: boolean; accounts: AccountView[]; active: string | null; updatedAt: string | null };

const fromBridge = (result: Record<string, unknown>): { summaries: AccountSummary[]; active: string | null } => ({
	summaries: (Array.isArray(result.accounts) ? result.accounts : []).map(toSummary).filter((s): s is AccountSummary => s !== null),
	active: typeof result.active === "string" ? result.active : null,
});

export const listAccounts = async (ctx: Context, { check = false } = {}): Promise<Listed> => {
	const result = await callBridge(mainSocket(ctx.home), { type: check ? "accounts.check" : "accounts.list" }, check ? 60_000 : 15_000);
	if (result.ok) {
		const { summaries, active } = fromBridge(result as Record<string, unknown>);
		return { connected: true, accounts: toViews(summaries, active), active, updatedAt: new Date().toISOString() };
	}
	const cached = readAccountsStatus(ctx.home);
	return { connected: false, accounts: toViews(cached.accounts, null), active: null, updatedAt: cached.updatedAt };
};

const isExecutable = (path: string): boolean => {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

const mainRunning = (env: NodeJS.ProcessEnv): boolean => isRunning(chromiumSupportDir(env), undefined, pidAlive).running;

const waitForBridge = async (socket: string, type: string, deadlineMs: number): Promise<boolean> => {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (existsSync(socket) && (await callBridge(socket, { type }, 5_000)).ok) return true;
		await delay(500);
	}
	return false;
};

export const ensureMainBrowser = async (ctx: Context): Promise<Result<{ started: boolean }>> => {
	const socket = mainSocket(ctx.home);
	if ((await callBridge(socket, { type: "ping" }, 10_000)).ok) return { ok: true, started: false };
	if (mainRunning(ctx.env)) {
		return fail("browser_unavailable", "Your main Chromium is open but Claude Profiles is not connected; press Reload extension in its popup");
	}
	const binary = chromiumBinary(ctx.env);
	if (!isExecutable(binary)) return fail("chromium_not_found", `Chromium not found at ${binary}`);
	const child = spawn(binary, [], { detached: true, stdio: "ignore" });
	child.on("error", (error) => process.stderr.write(`ccp: Chromium failed to start: ${error.message}\n`));
	child.unref();
	return (await waitForBridge(socket, "ping", BROWSER_START_MS))
		? { ok: true, started: true }
		: fail("browser_unavailable", "Started Chromium, but Claude Profiles did not connect; check it is loaded in your main profile");
};

const notFound = (ref: string) => fail("not_found", `No saved account matches ${ref}; save it in the Claude Profiles popup first`);

export const openAccount = async (ctx: Context, ref: unknown, url: unknown): Promise<Result<object>> => {
	if (typeof ref !== "string" || ref.length === 0 || ref.length > 254) return fail("invalid_request", "Name an account");
	if (url !== undefined && url !== null && !isSafeUrl(url)) return fail("invalid_request", "url must be an http or https URL");
	const ready = await ensureMainBrowser(ctx);
	if (!ready.ok) return ready;
	const { accounts } = await listAccounts(ctx);
	const account = resolveAccount(accounts, ref) ?? resolveAccount(accounts, legacyEmail(ctx.home, ref) ?? "\0");
	if (!account) return notFound(ref);
	const result = await callBridge(mainSocket(ctx.home), { type: "accounts.open", label: account.label, url: url ?? null }, 60_000);
	if (!result.ok) return result;
	const { ok: _ok, ...rest } = result as Record<string, unknown>;
	return { ok: true, ...rest, account: { ...account, active: true }, startedBrowser: ready.started };
};

const isClaudeUrl = (url: unknown): url is string => {
	if (!isSafeUrl(url)) return false;
	const { protocol, hostname } = new URL(url);
	return protocol === "https:" && (hostname === "claude.ai" || hostname.endsWith(".claude.ai"));
};

export const openFor = async (ctx: Context, url: unknown): Promise<Result<object>> => {
	if (!isClaudeUrl(url)) return fail("invalid_request", "open-for takes an https://claude.ai/ link");
	const ready = await ensureMainBrowser(ctx);
	if (!ready.ok) return ready;
	const result = await callBridge(mainSocket(ctx.home), { type: "accounts.openFor", url }, OPEN_FOR_TIMEOUT_MS);
	if (!result.ok) return result;
	const { accounts } = await listAccounts(ctx);
	const label = (result as Record<string, unknown>).label;
	const { ok: _ok, ...rest } = result as Record<string, unknown>;
	return { ok: true, ...rest, account: accounts.find((view) => view.label === label) ?? null };
};

export type MigrationOutcome = "imported" | "already-signed-in" | "signed-out" | "unreachable";
export type MigrationRow = { profile: string; email: string | null; outcome: MigrationOutcome; reason?: string; label?: string };

type Launch = (ctx: Context, profile: Profile) => Promise<Result<{ pid: number | null }>>;

const headlessLaunch: Launch = async (ctx, profile) => {
	const env = { ...ctx.env, CCP_EXTRA_ARGS: `${ctx.env.CCP_EXTRA_ARGS ?? ""} --headless=new`.trim() };
	const launched = await launchProfile(ctx.home, profile, null, env);
	return launched.ok ? { ok: true, pid: launched.profile.pid } : launched;
};

const stopStarted = async (pid: number | null): Promise<void> => {
	if (pid === null) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	for (let i = 0; i < 50 && pidAlive(pid); i++) await delay(100);
};

const migrateProfile = async (ctx: Context, profile: Profile, launch: Launch): Promise<MigrationRow> => {
	const row = { profile: profile.name, email: profile.email };
	const socket = profileSocket(ctx.home, profile.name);
	const wasRunning = isRunning(userDataDir(ctx.home, profile.name)).running;
	let started: number | null = null;
	if (!wasRunning) {
		const launched = await launch(ctx, profile);
		if (!launched.ok) return { ...row, outcome: "unreachable", reason: launched.error.message };
		started = launched.pid;
	}
	try {
		if (!(await waitForBridge(socket, "ping", PROFILE_START_MS))) {
			return {
				...row,
				outcome: "unreachable",
				reason: "its Claude Profiles extension did not connect; open the profile once, press Reload extension, then run ccp migrate again",
			};
		}
		const exported = await callBridge(socket, { type: "accounts.exportLive" }, 15_000);
		if (!exported.ok) {
			return { ...row, outcome: exported.error.code === "session_expired" ? "signed-out" : "unreachable", reason: exported.error.message };
		}
		const { email, cookies } = exported as unknown as { email: string; cookies: unknown };
		const imported = await callBridge(mainSocket(ctx.home), { type: "accounts.import", label: profile.email ?? email, email, cookies }, 30_000);
		if (!imported.ok) return { ...row, email, outcome: imported.error.code === "session_expired" ? "signed-out" : "unreachable", reason: imported.error.message };
		const body = imported as unknown as { imported: boolean; label: string };
		return { ...row, email, label: body.label, outcome: body.imported ? "imported" : "already-signed-in" };
	} finally {
		await stopStarted(started);
	}
};

export const migrate = async (ctx: Context, { launch = headlessLaunch }: { launch?: Launch } = {}): Promise<Result<object>> => {
	const ready = await ensureMainBrowser(ctx);
	if (!ready.ok) return ready;
	const rows: MigrationRow[] = [];
	for (const profile of readProfiles(ctx.home)) rows.push(await migrateProfile(ctx, profile, launch));
	const { accounts } = await listAccounts(ctx, { check: true });
	return {
		ok: true,
		profiles: rows,
		accounts,
		needSignIn: accounts.filter((account) => account.state === "signed-out").map((account) => account.email ?? account.label),
	};
};
