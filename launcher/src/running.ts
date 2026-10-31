import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";

export const parseSingletonLock = (target: string): { host: string; pid: number } | null => {
	const dash = target.lastIndexOf("-");
	if (dash <= 0) return null;
	const pidText = target.slice(dash + 1);
	if (!/^[0-9]+$/.test(pidText)) return null;
	const pid = Number(pidText);
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	return { host: target.slice(0, dash), pid };
};

export const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

export const userDataDirFromArgs = (args: string): string | null =>
	/--user-data-dir=(.+?)(?= --|$)/.exec(args.trim())?.[1] ?? null;

const processArgs = (pid: number): string | null => {
	try {
		return execFileSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" });
	} catch {
		return null;
	}
};

export const isBrowserFor = (userDataDir: string, pid: number): boolean => {
	if (!pidAlive(pid)) return false;
	const args = processArgs(pid);
	return args !== null && userDataDirFromArgs(args) === userDataDir;
};

const readLock = (userDataDir: string): string | null => {
	try {
		return readlinkSync(join(userDataDir, "SingletonLock"));
	} catch {
		return null;
	}
};

export const isRunning = (
	userDataDir: string,
	hostname: string = osHostname(),
	alive: (pid: number) => boolean = (pid) => isBrowserFor(userDataDir, pid),
): { running: boolean; pid: number | null } => {
	const target = readLock(userDataDir);
	const lock = target === null ? null : parseSingletonLock(target);
	if (lock === null) return { running: false, pid: null };
	const sameHost = lock.host === hostname || lock.host === hostname.split(".")[0];
	if (!sameHost || !alive(lock.pid)) return { running: false, pid: null };
	return { running: true, pid: lock.pid };
};
