import { listAccounts, reloginStatus } from "./lib/jars.js";
import { sendNative } from "./lib/native.js";

const byId = (id) => document.getElementById(id);

const send = (msg) => chrome.runtime.sendMessage(msg);

const element = (tag, props = {}, children = []) => {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
};

const showMessage = (id, text) => {
	const node = byId(id);
	node.textContent = text ?? "";
	node.hidden = !text;
};

const disableWhile = (node, onClick) => async () => {
	node.disabled = true;
	try {
		await onClick();
	} finally {
		node.disabled = false;
	}
};

const button = (label, onClick) => {
	const node = element("button", { type: "button", textContent: label });
	node.onclick = disableWhile(node, onClick);
	return node;
};

const STATUS_CHIPS = {
	expiring: { text: "Expires soon", className: "chip expiring" },
	ok: { text: "Signed in", className: "chip ok" },
	revoked: { text: "Signed out", className: "chip revoked" },
	unknown: { text: "Couldn't check", className: "chip" },
};

const UNCHECKED_CHIP = { text: "Unchecked", className: "chip" };

const EXPIRING_MS = 3 * 24 * 60 * 60 * 1000;

const chipKey = ({ status, sessionExpiresAt }) => {
	const expiresAt = sessionExpiresAt ? Date.parse(sessionExpiresAt) : null;
	if (expiresAt !== null && expiresAt <= Date.now()) return "revoked";
	if (status === "ok" && expiresAt !== null && expiresAt - Date.now() < EXPIRING_MS) return "expiring";
	return status;
};

const statusChip = (account) => {
	const chip = STATUS_CHIPS[chipKey(account)] ?? UNCHECKED_CHIP;
	const checked = account.checkedAt ? `Checked ${new Date(account.checkedAt).toLocaleString()}` : "Not checked yet";
	const expires = account.sessionExpiresAt ? `; session expires ${new Date(account.sessionExpiresAt).toLocaleString()}` : "";
	return element("span", { className: chip.className, textContent: chip.text, title: `${checked}${expires}` });
};

const accountRow = (account) =>
	element("li", { className: "row" }, [
		element("span", { className: "identity" }, [
			element("span", { className: "name" }, [account.label, statusChip(account)]),
			element("span", {
				className: "meta",
				textContent: `${account.cookieCount} cookies, saved ${new Date(account.savedAt).toLocaleString()}`,
			}),
		]),
		button("Switch", () => switchAccount(account.label)),
		button("Forget", () => forgetAccount(account.label)),
	]);

const emptyRow = (text) => element("li", { className: "empty", textContent: text });

const showBridge = async () => {
	const startedAt = performance.now();
	const result = await sendNative({ type: "ping" });
	const elapsed = Math.round(performance.now() - startedAt);
	if (!result.ok) {
		showMessage("profiles-error", result.error.message);
		showMessage("status", null);
	} else {
		showMessage("profiles-error", null);
		showMessage("status", `Launcher answered in ${elapsed} ms`);
	}
	const bridge = await send({ type: "bridge.status" });
	byId("bridge").textContent = bridge.ok && bridge.connected
		? "Agents can switch accounts and open claude.ai links here with ccp."
		: "ccp can't reach this browser yet. Run: ccp install-host --chromium-default, then Reload extension.";
};

const showRelogin = (accounts, relogin) => {
	byId("relogin").hidden = Boolean(relogin) || !accounts.some((account) => account.status === "revoked");
	byId("relogin-active").hidden = !relogin;
	byId("relogin-pending").textContent = relogin
		? `Signing back in: ${relogin.pending.join(", ")} — Claude is driving this browser`
		: "";
};

const showAccounts = (accounts, relogin) => {
	byId("accounts").replaceChildren(...(accounts.length ? accounts.map(accountRow) : [emptyRow("No saved accounts")]));
	showRelogin(accounts, relogin);
};

const renderAccounts = async () => {
	const result = await listAccounts();
	if (!result.ok) {
		showMessage("accounts-error", result.error.message);
		byId("accounts").replaceChildren();
		return;
	}
	showAccounts(result.accounts, (await reloginStatus()).relogin);
};

const checkAccounts = async () => {
	const result = await send({ type: "accounts.check" });
	if (!result.ok) showMessage("accounts-error", result.error.message);
};

const driverText = (driver) =>
	driver?.profile ? `Driven by the ${driver.profile} profile's Claude Code.` : "Driven by Claude Code.";

const reloginResultText = ({ skipped, driver }) =>
	[
		...(skipped?.length ? [`Skipped: ${skipped.map(({ email, reason }) => `${email} (${reason})`).join(", ")}.`] : []),
		driverText(driver),
	].join(" ");

const switchAccount = async (label) => {
	const result = await send({ type: "accounts.switch", label });
	showMessage("accounts-error", result.ok ? null : result.error.message);
};

const forgetAccount = async (label) => {
	const result = await send({ type: "accounts.forget", label });
	showMessage("accounts-error", result.ok ? null : result.error.message);
};

byId("save-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	const label = String(new FormData(form).get("label") ?? "").trim();
	const result = await send({ type: "accounts.save", label });
	showMessage("accounts-error", result.ok ? null : result.error.message);
	if (result.ok) form.reset();
});

byId("relogin").addEventListener(
	"click",
	disableWhile(byId("relogin"), async () => {
		const result = await send({ type: "accounts.relogin" });
		showMessage("accounts-error", result.ok ? null : result.error.message);
		if (result.ok) showMessage("relogin-result", result.started ? reloginResultText(result) : result.message);
	}),
);

byId("relogin-cancel").addEventListener("click", async () => {
	const result = await send({ type: "accounts.reloginCancel" });
	showMessage("accounts-error", result.ok ? null : result.error.message);
	showMessage("relogin-result", null);
});

chrome.storage.onChanged.addListener((changes) => {
	if ("jars" in changes || "relogin" in changes) renderAccounts();
});

byId("reload").addEventListener("click", () => chrome.runtime.reload());

byId("sign-in-another").addEventListener("click", async () => {
	const result = await send({ type: "accounts.signIn" });
	showMessage("accounts-error", result.ok ? null : result.error.message);
});

renderAccounts().then(checkAccounts);
showBridge();
