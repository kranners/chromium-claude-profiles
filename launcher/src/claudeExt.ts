import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { vendorDir } from "./paths.ts";

const VERSION_DIR = /^([0-9]+(?:\.[0-9]+)*)(?:_([0-9]+))?$/;

type VersionKey = { segments: number[]; build: number };

const versionKey = (dirName: string): VersionKey | null => {
	const match = VERSION_DIR.exec(dirName);
	if (!match) return null;
	return { segments: match[1].split(".").map(Number), build: Number(match[2] ?? 0) };
};

const compareKeys = (left: VersionKey, right: VersionKey): number => {
	for (let index = 0; index < Math.max(left.segments.length, right.segments.length); index++) {
		const difference = (left.segments[index] ?? 0) - (right.segments[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return left.build - right.build;
};

const readManifestVersion = (dir: string): string | null => {
	try {
		const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
		return typeof manifest.version === "string" ? manifest.version : null;
	} catch {
		return null;
	}
};

export const findClaudeExtension = (sourceDir: string): { version: string; dir: string } | null => {
	let entries: string[];
	try {
		entries = readdirSync(sourceDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return null;
	}
	const candidates = entries
		.map((name) => ({ name, key: versionKey(name), version: readManifestVersion(join(sourceDir, name)) }))
		.filter((candidate) => candidate.key !== null && candidate.version !== null)
		.sort((left, right) => compareKeys(right.key as VersionKey, left.key as VersionKey));
	const best = candidates[0];
	return best ? { version: best.version as string, dir: join(sourceDir, best.name) } : null;
};

export const vendorClaudeExtension = (home: string, sourceDir: string): string | null => {
	const found = findClaudeExtension(sourceDir);
	if (!found) return null;
	const target = join(vendorDir(home), basename(found.dir));
	if (existsSync(join(target, "manifest.json"))) return target;
	mkdirSync(vendorDir(home), { recursive: true });
	const staging = `${target}.${process.pid}.tmp`;
	rmSync(staging, { recursive: true, force: true });
	cpSync(found.dir, staging, { recursive: true });
	try {
		renameSync(staging, target);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if ((code !== "EEXIST" && code !== "ENOTEMPTY") || !existsSync(join(target, "manifest.json"))) throw error;
		rmSync(staging, { recursive: true, force: true });
	}
	return target;
};
