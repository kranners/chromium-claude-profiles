import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PROFILE_NAME, profilesFile, userDataDir } from "./paths.ts";
import type { Failure, Profile, ProfileView, Result } from "./protocol.ts";
import { isRunning } from "./running.ts";

export const SCHEMA_VERSION = 1;

export const fail = (code: Failure["error"]["code"], message: string): Failure => ({
	ok: false,
	error: { code, message },
});

export const ensureHome = (home: string): void => {
	mkdirSync(home, { recursive: true, mode: 0o700 });
	chmodSync(home, 0o700);
};

const isProfile = (value: unknown): value is Profile => {
	const profile = value as Profile;
	return (
		typeof profile === "object" &&
		profile !== null &&
		typeof profile.name === "string" &&
		(profile.email === null || typeof profile.email === "string") &&
		(profile.configDir === null || typeof profile.configDir === "string") &&
		typeof profile.createdAt === "string"
	);
};

export const readProfiles = (home: string): Profile[] => {
	if (!existsSync(profilesFile(home))) return [];
	const parsed = JSON.parse(readFileSync(profilesFile(home), "utf8"));
	if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.profiles)) {
		throw new Error(`${profilesFile(home)} has an unknown schema`);
	}
	return parsed.profiles.filter(isProfile);
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
	if (!isValidName(input.name)) return fail("invalid_request", `Invalid profile name: must match ${PROFILE_NAME}`);
	const email = input.email ?? null;
	if (email !== null && (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email))) {
		return fail("invalid_request", "Invalid email");
	}
	const configDir = input.configDir ?? null;
	if (configDir !== null && (typeof configDir !== "string" || !isAbsolute(configDir) || !isExistingDirectory(configDir))) {
		return fail("invalid_request", "configDir must be an absolute path to an existing directory");
	}
	const profiles = readProfiles(home);
	if (profiles.some((profile) => profile.name === input.name)) {
		return fail("already_exists", `Profile ${input.name} already exists`);
	}
	const duplicate = email === null ? undefined : profiles.find((profile) => profile.email?.toLowerCase() === email.toLowerCase());
	if (duplicate) return fail("already_exists", `Profile ${duplicate.name} already uses ${email}`);
	const profile: Profile = { name: input.name, email, configDir, createdAt: new Date().toISOString() };
	writeProfiles(home, [...profiles, profile]);
	mkdirSync(userDataDir(home, profile.name), { recursive: true, mode: 0o700 });
	return { ok: true, profile };
};

export const removeProfile = (home: string, name: unknown, keepData = false): Result<{}> => {
	if (!isValidName(name)) return fail("invalid_request", "Invalid profile name");
	const profiles = readProfiles(home);
	const profile = profiles.find((candidate) => candidate.name === name);
	if (!profile) return fail("not_found", `No profile named ${name}`);
	if (viewOf(home, profile).running) return fail("running", `Profile ${name} is running; quit it first`);
	writeProfiles(home, profiles.filter((candidate) => candidate.name !== name));
	if (!keepData) rmSync(userDataDir(home, name), { recursive: true, force: true });
	return { ok: true };
};
