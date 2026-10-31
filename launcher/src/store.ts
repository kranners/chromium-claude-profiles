import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PROFILE_NAME, profilesFile, userDataDir } from "./paths.ts";
import type { Failure, Profile, ProfileView, Result } from "./protocol.ts";
import { isRunning, pidAlive } from "./running.ts";

export const SCHEMA_VERSION = 1;

export const fail = (code: Failure["error"]["code"], message: string): Failure => ({
	ok: false,
	error: { code, message },
});

export const ensureHome = (home: string): void => {
	mkdirSync(home, { recursive: true, mode: 0o700 });
	chmodSync(home, 0o700);
};

const toProfile = (value: unknown): Profile | null => {
	if (typeof value !== "object" || value === null) return null;
	const entry = value as Partial<Profile>;
	const email = entry.email ?? null;
	const configDir = entry.configDir ?? null;
	if (typeof entry.name !== "string" || typeof entry.createdAt !== "string") return null;
	if (email !== null && typeof email !== "string") return null;
	if (configDir !== null && typeof configDir !== "string") return null;
	return { ...entry, name: entry.name, email, configDir, createdAt: entry.createdAt };
};

const unknownSchema = (home: string): Error => new Error(`${profilesFile(home)} has an unknown schema`);

export const readProfiles = (home: string): Profile[] => {
	if (!existsSync(profilesFile(home))) return [];
	const parsed = JSON.parse(readFileSync(profilesFile(home), "utf8"));
	if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.profiles)) throw unknownSchema(home);
	const profiles = parsed.profiles.map(toProfile);
	if (profiles.includes(null)) throw unknownSchema(home);
	return profiles;
};

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 20;

const sleepSync = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const lockHolder = (lock: string): number | null => {
	try {
		return Number.parseInt(readFileSync(lock, "utf8"), 10);
	} catch {
		return null;
	}
};

const withProfilesLock = <T>(home: string, fn: () => T): T => {
	ensureHome(home);
	const lock = `${profilesFile(home)}.lock`;
	const claim = `${lock}.${process.pid}.tmp`;
	writeFileSync(claim, String(process.pid), { mode: 0o600 });
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	try {
		for (;;) {
			try {
				linkSync(claim, lock);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const holder = lockHolder(lock);
			if (holder !== null && !(Number.isSafeInteger(holder) && holder > 0 && pidAlive(holder))) {
				rmSync(lock, { force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}`);
			sleepSync(LOCK_RETRY_MS);
		}
	} finally {
		rmSync(claim, { force: true });
	}
	try {
		return fn();
	} finally {
		rmSync(lock, { force: true });
	}
};

export const writeProfiles = (home: string, profiles: Profile[]): void => {
	ensureHome(home);
	const target = profilesFile(home);
	const temporary = `${target}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, profiles }, null, 2)}\n`, {
		mode: 0o600,
	});
	chmodSync(temporary, 0o600);
	renameSync(temporary, target);
};

export const isValidName = (name: unknown): name is string =>
	typeof name === "string" && PROFILE_NAME.test(name);

export const findProfile = (home: string, name: string): Profile | undefined =>
	readProfiles(home).find((profile) => profile.name === name);

export const viewOf = (home: string, profile: Profile): ProfileView => {
	const dir = userDataDir(home, profile.name);
	return { ...profile, userDataDir: dir, ...isRunning(dir) };
};

const isExistingDirectory = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

export type NewProfile = { name: unknown; email?: unknown; configDir?: unknown };

export const addProfile = (home: string, input: NewProfile): Result<{ profile: Profile }> => {
	const { name } = input;
	if (!isValidName(name)) return fail("invalid_request", `Invalid profile name: must match ${PROFILE_NAME}`);
	const email = input.email ?? null;
	if (email !== null && (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email))) {
		return fail("invalid_request", "Invalid email");
	}
	const configDir = input.configDir ?? null;
	if (configDir !== null && (typeof configDir !== "string" || !isAbsolute(configDir) || !isExistingDirectory(configDir))) {
		return fail("invalid_request", "configDir must be an absolute path to an existing directory");
	}
	return withProfilesLock(home, () => insertProfile(home, name, email, configDir));
};

const insertProfile = (home: string, name: string, email: string | null, configDir: string | null): Result<{ profile: Profile }> => {
	const profiles = readProfiles(home);
	if (profiles.some((profile) => profile.name === name)) {
		return fail("already_exists", `Profile ${name} already exists`);
	}
	const duplicate = email === null ? undefined : profiles.find((profile) => profile.email?.toLowerCase() === email.toLowerCase());
	if (duplicate) return fail("already_exists", `Profile ${duplicate.name} already uses ${email}`);
	const profile: Profile = { name, email, configDir, createdAt: new Date().toISOString() };
	writeProfiles(home, [...profiles, profile]);
	mkdirSync(userDataDir(home, profile.name), { recursive: true, mode: 0o700 });
	return { ok: true, profile };
};

export const removeProfile = (home: string, name: unknown, keepData = false): Result<{}> => {
	if (!isValidName(name)) return fail("invalid_request", "Invalid profile name");
	return withProfilesLock(home, () => deleteProfile(home, name, keepData));
};

const deleteProfile = (home: string, name: string, keepData: boolean): Result<{}> => {
	const profiles = readProfiles(home);
	const profile = profiles.find((candidate) => candidate.name === name);
	if (!profile) return fail("not_found", `No profile named ${name}`);
	if (viewOf(home, profile).running) return fail("running", `Profile ${name} is running; quit it first`);
	writeProfiles(home, profiles.filter((candidate) => candidate.name !== name));
	if (!keepData) rmSync(userDataDir(home, name), { recursive: true, force: true });
	return { ok: true };
};
