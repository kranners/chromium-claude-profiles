const byId = (id) => document.getElementById(id);

const send = (msg) => chrome.runtime.sendMessage(msg);

const activeTabUrl = async () => {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	return tab?.url ?? null;
};

const OUTCOMES = {
	swapped: "switched to",
	stay: "already on",
	unresolved: "no saved account could see",
	closed: "tab closed before",
};

const lastText = (last) =>
	last ? `Last: ${OUTCOMES[last.outcome] ?? last.outcome}${last.label ? ` ${last.label}` : ""} for ${last.key}.` : "";

const render = (state) => {
	byId("autoswap-enabled").checked = state.enabled;
	byId("autoswap-pending").hidden = state.confirmed || !state.pending;
	byId("autoswap-last").textContent = lastText(state.last);
	byId("autoswap-last").hidden = !state.last;
	byId("autoswap-link").hidden = !state.link;
	if (state.link) {
		byId("autoswap-link-optout").checked = state.link.optedOut;
		byId("autoswap-link-key").textContent = state.link.owner
			? `This tab's link (${state.link.key}) belongs to ${state.link.owner}.`
			: `This tab's link (${state.link.key}) has no remembered account yet.`;
	}
	byId("autoswap-clear").textContent = `Forget ${state.cacheSize} remembered link${state.cacheSize === 1 ? "" : "s"}`;
	byId("autoswap-clear").disabled = state.cacheSize === 0;
};

const refresh = async () => {
	const state = await send({ type: "autoswap.get", url: await activeTabUrl() });
	if (state.ok) render(state);
};

byId("autoswap-enabled").addEventListener("change", async (event) => {
	await send({ type: "autoswap.setEnabled", enabled: event.currentTarget.checked });
	refresh();
});

byId("autoswap-link-optout").addEventListener("change", async (event) => {
	await send({ type: "autoswap.setLinkOptOut", url: await activeTabUrl(), optedOut: event.currentTarget.checked });
	refresh();
});

byId("autoswap-clear").addEventListener("click", async () => {
	await send({ type: "autoswap.clearCache" });
	refresh();
});

chrome.storage.onChanged.addListener((changes) => {
	if ("autoswap" in changes) refresh();
});

refresh();
