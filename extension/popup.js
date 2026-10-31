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

const button = (label, onClick) =>
	element("button", {
		type: "button",
		textContent: label,
		onclick: async (event) => {
			event.currentTarget.disabled = true;
			await onClick();
		},
	});

const profileRow = (profile, current) =>
	element("li", { className: "row" }, [
		element("span", { className: profile.running ? "dot running" : "dot", title: profile.running ? "Running" : "Stopped" }),
		element("span", { className: "identity" }, [
			element("span", { className: "name" }, [
				profile.name,
				...(profile.name === current ? [element("span", { className: "this-window", textContent: "this window" })] : []),
			]),
			element("span", { className: "email", textContent: profile.email ?? "" }),
		]),
		button(profile.running ? "Focus" : "Launch", () => launchProfile(profile.name)),
	]);

const accountRow = (account) =>
	element("li", { className: "row" }, [
		element("span", { className: "identity" }, [
			element("span", { className: "name", textContent: account.label }),
			element("span", {
				className: "meta",
				textContent: `${account.cookieCount} cookies, saved ${new Date(account.savedAt).toLocaleString()}`,
			}),
		]),
		button("Switch", () => switchAccount(account.label)),
		button("Forget", () => forgetAccount(account.label)),
	]);

const emptyRow = (text) => element("li", { className: "empty", textContent: text });

const renderProfiles = async () => {
	const result = await send({ type: "profiles.list" });
	const list = byId("profiles");
	if (!result.ok) {
		showMessage("profiles-error", result.error.message);
		list.replaceChildren();
		return;
	}
	showMessage("profiles-error", null);
	list.replaceChildren(
		...(result.profiles.length
			? result.profiles.map((profile) => profileRow(profile, result.current))
			: [emptyRow("No profiles. Run: ccp add <name>")]),
	);
};

const renderAccounts = async () => {
	const result = await send({ type: "accounts.list" });
	const list = byId("accounts");
	if (!result.ok) {
		showMessage("accounts-error", result.error.message);
		list.replaceChildren();
		return;
	}
	list.replaceChildren(
		...(result.accounts.length ? result.accounts.map(accountRow) : [emptyRow("No saved accounts")]),
	);
};

const launchProfile = async (name) => {
	const result = await send({ type: "profiles.launch", name });
	showMessage("profiles-error", result.ok ? null : result.error.message);
	await renderProfiles();
};

const switchAccount = async (label) => {
	const result = await send({ type: "accounts.switch", label });
	showMessage("accounts-error", result.ok ? null : result.error.message);
	await renderAccounts();
};

const forgetAccount = async (label) => {
	const result = await send({ type: "accounts.forget", label });
	showMessage("accounts-error", result.ok ? null : result.error.message);
	await renderAccounts();
};

byId("save-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	const label = String(new FormData(form).get("label") ?? "").trim();
	const result = await send({ type: "accounts.save", label });
	showMessage("accounts-error", result.ok ? null : result.error.message);
	if (result.ok) form.reset();
	await renderAccounts();
});

byId("sign-in-another").addEventListener("click", async () => {
	const result = await send({ type: "accounts.signIn" });
	showMessage("accounts-error", result.ok ? null : result.error.message);
});

renderProfiles();
renderAccounts();
