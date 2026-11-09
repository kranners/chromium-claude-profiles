import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callBridge, MAIN_BROWSER } from "./bridge.ts";
import { EXTENSION_ID, HOST_NAME } from "./hostManifest.ts";
import { bridgeSocket, browserOf, chromiumDefaultHostsDir, ourExtensionDir, platformOf } from "./paths.ts";
import type { Context } from "./protocol.ts";

export type Check = { name: string; ok: boolean; detail: string; fix?: string };

export type DoctorInputs = {
	nodeMajor: number;
	platform: string;
	browser: string;
	extensionDir: string;
	extensionDirExists: boolean;
	hostManifest: { path: string; exists: boolean; wrapperExists: boolean; originOk: boolean };
	bridgeConnected: boolean;
	accounts: { count: number; signedOut: number } | null;
};

export type Diagnosis = { ready: boolean; checks: Check[]; next: string };

// Turns what was observed into a checklist and the one thing to do next. Pure, so it is unit tested.
export const diagnose = (i: DoctorInputs): Diagnosis => {
	const checks: Check[] = [
		{
			name: "Node 24 or newer",
			ok: i.nodeMajor >= 24,
			detail: `Node ${i.nodeMajor}`,
			fix: "Install Node 24 or newer (macOS: brew install node; Linux: your package manager or fnm), then run install.sh again.",
		},
		{
			name: "Supported system",
			ok: i.platform === "darwin" || i.platform === "linux",
			detail: i.platform,
			fix: "ccp supports macOS and Linux only.",
		},
		{
			name: "Extension folder",
			ok: i.extensionDirExists,
			detail: i.extensionDir,
			fix: "The checkout is incomplete; run install.sh again.",
		},
		{
			name: "Native messaging host",
			ok: i.hostManifest.exists && i.hostManifest.wrapperExists && i.hostManifest.originOk,
			detail: i.hostManifest.exists ? i.hostManifest.path : `missing ${i.hostManifest.path}`,
			fix: `Run: ccp install-host --browser ${i.browser}`,
		},
		{
			name: "Extension connected",
			ok: i.bridgeConnected,
			detail: i.bridgeConnected ? `Claude Profiles is answering in ${i.browser}` : `no answer from ${i.browser}`,
			fix: `In ${i.browser}, open chrome://extensions, turn on Developer mode, choose Load unpacked and pick ${i.extensionDir}. If it is already loaded, press Reload extension in its popup. Keep the browser open.`,
		},
	];
	const broken = checks.find((check) => !check.ok);
	if (broken) return { ready: false, checks, next: broken.fix ?? broken.name };
	const count = i.accounts?.count ?? 0;
	const next =
		count === 0
			? "Sign in to claude.ai in the browser, then run: ccp save <label> (a short name such as personal or work)."
			: i.accounts && i.accounts.signedOut > 0
				? "Some saved accounts are signed out; open the Claude Profiles popup and use Sign back in, or sign in and run ccp save <label> again."
				: "Ready. To add another account: ccp sign-in-another, sign in in the browser, then ccp save <label>.";
	return { ready: true, checks, next };
};

const hostManifestState = (env: NodeJS.ProcessEnv): DoctorInputs["hostManifest"] => {
	const path = join(chromiumDefaultHostsDir(env), `${HOST_NAME}.json`);
	if (!existsSync(path)) return { path, exists: false, wrapperExists: false, originOk: false };
	try {
		const manifest = JSON.parse(readFileSync(path, "utf8"));
		return {
			path,
			exists: true,
			wrapperExists: typeof manifest.path === "string" && existsSync(manifest.path),
			originOk: Array.isArray(manifest.allowed_origins) && manifest.allowed_origins.includes(`chrome-extension://${EXTENSION_ID}/`),
		};
	} catch {
		return { path, exists: true, wrapperExists: false, originOk: false };
	}
};

export const gather = async (ctx: Context): Promise<DoctorInputs> => {
	const extensionDir = ourExtensionDir(ctx.env);
	const pong = await callBridge(bridgeSocket(ctx.home, MAIN_BROWSER), { type: "accounts.list" }, 8_000);
	const accounts = pong.ok
		? (pong as unknown as { accounts?: { status?: string | null }[] }).accounts ?? []
		: null;
	return {
		nodeMajor: Number(process.versions.node.split(".")[0]),
		platform: platformOf(ctx.env),
		browser: browserOf(ctx.env),
		extensionDir,
		extensionDirExists: existsSync(join(extensionDir, "manifest.json")),
		hostManifest: hostManifestState(ctx.env),
		bridgeConnected: pong.ok,
		accounts: accounts === null ? null : { count: accounts.length, signedOut: accounts.filter((a) => a.status === "revoked").length },
	};
};
