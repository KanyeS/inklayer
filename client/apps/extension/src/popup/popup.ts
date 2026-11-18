import { send, type StateResponse } from "../lib/messages";
import { normaliseServerUrl, updateSettings } from "../lib/settings";

const app = document.getElementById("app")!;
const who = document.getElementById("who")!;
const SITE_ACCESS: chrome.permissions.Permissions = { origins: ["https://*/*", "http://*/*"] };

/** Tiny element builder. Uses textContent only, so no value from the server is ever parsed as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

function render(...nodes: Node[]): void {
  app.replaceChildren(...nodes);
}

async function refresh(): Promise<void> {
  let state: StateResponse;
  try {
    state = await send({ type: "state" });
  } catch (error) {
    render(h("p", { className: "error", textContent: (error as Error).message }), h("button", { textContent: "Retry", onclick: refresh }));
    return;
  }

  who.textContent = state.me?.email ?? "";
  if (!state.serverUrl) return renderSetup(state);
  if (!state.signedIn || !state.me) return renderSignIn(state);
  return renderSignedIn(state);
}

function renderSetup(state: StateResponse, error?: string): void {
  const input = h("input", { type: "url", placeholder: "https://inklayer.example.com", value: state.serverUrl ?? "", required: true });
  const save = h("button", { className: "primary", textContent: "Connect" });
  const message = h("p", { className: "error", textContent: error ?? "" });

  save.onclick = async () => {
    try {
      const serverUrl = normaliseServerUrl(input.value);
      // Needed to reach the server, and to show comments on the pages you visit.
      if (!(await chrome.permissions.request(SITE_ACCESS))) throw new Error("Inklayer needs site access to show comments on pages.");
      await updateSettings({ serverUrl, tokens: null });
      await refresh();
    } catch (e) {
      message.textContent = (e as Error).message;
    }
  };

  render(
    h("label", {}, "Inklayer server", input),
    save,
    message,
    h("p", { className: "muted" }, "Ask your administrator to allow this extension's sign-in address:"),
    h("code", { textContent: state.redirectUri }),
  );
}

function renderSignIn(state: StateResponse, error?: string): void {
  const button = h("button", { className: "primary", textContent: "Sign in" });
  const message = h("p", { className: "error", textContent: error ?? "" });
  button.onclick = async () => {
    button.disabled = true;
    message.textContent = "";
    try {
      await send({ type: "signIn" });
      await refresh();
    } catch (e) {
      button.disabled = false;
      message.textContent = (e as Error).message;
    }
  };
  render(
    h("p", { className: "muted" }, "Server: ", h("code", { textContent: state.serverUrl ?? "" })),
    button,
    message,
    h("button", { className: "link", textContent: "Change server", onclick: () => renderSetup(state) }),
  );
}

function renderSignedIn(state: StateResponse): void {
  if (state.me!.organizations.length === 0) {
    render(h("p", {}, "You're signed in, but not a member of any organisation yet. Ask an administrator to invite you."), footer(state));
    return;
  }

  const error = h("p", { className: "error" });
  const comment = h("button", { className: "primary", textContent: "Comment on this page", onclick: async () => {
    // Ask before any other await: Firefox only allows permission requests directly inside the click.
    // If access is already granted, this returns true without prompting.
    if (!(await chrome.permissions.request(SITE_ACCESS))) {
      error.textContent = "Site access is needed to show comments on pages.";
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      await send({ type: "openLive", tabId: tab.id });
      window.close();
    } catch {
      error.textContent = "Inklayer can't open on this page (browser pages and extension stores are off limits).";
    }
  } });

  render(
    comment,
    h("p", { className: "muted", textContent: "Comments appear on the page for everyone in your projects who has the extension." }),
    error,
    footer(state),
  );
}

function footer(state: StateResponse): HTMLElement {
  return h("div", { className: "row" },
    h("button", { className: "link", textContent: "Settings", onclick: () => renderSettings(state) }),
    h("button", { className: "link", textContent: "Sign out", onclick: async () => { await send({ type: "signOut" }); await refresh(); } }),
  );
}

function renderSettings(state: StateResponse): void {
  render(
    h("p", { className: "muted" }, "Server: ", h("code", { textContent: state.serverUrl ?? "" })),
    h("button", { className: "link", textContent: "Change server", onclick: () => renderSetup(state) }),
    h("button", { className: "link", textContent: "Back", onclick: refresh }),
  );
}

void refresh();
