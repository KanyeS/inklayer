import type { Project } from "../lib/api";
import type { CaptureStatus } from "../lib/capture";
import { send, type StateResponse } from "../lib/messages";
import { getSettings, normaliseServerUrl, updateSettings } from "../lib/settings";

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
  return renderCapture(state);
}

function renderSetup(state: StateResponse, error?: string): void {
  const input = h("input", { type: "url", placeholder: "https://inklayer.example.com", value: state.serverUrl ?? "", required: true });
  const save = h("button", { className: "primary", textContent: "Connect" });
  const message = h("p", { className: "error", textContent: error ?? "" });

  save.onclick = async () => {
    try {
      const serverUrl = normaliseServerUrl(input.value);
      // Needed to reach the server, and to fetch the images, fonts and styles of pages you capture.
      if (!(await chrome.permissions.request(SITE_ACCESS))) throw new Error("Inklayer needs site access to capture pages.");
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
  const button = h("button", { className: "primary", textContent: "Sign in with Google" });
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

async function renderCapture(state: StateResponse): Promise<void> {
  const me = state.me!;
  if (me.organizations.length === 0) {
    render(h("p", {}, "You're signed in, but not a member of any organisation yet. Ask an administrator to invite you."), footer(state));
    return;
  }

  const orgSelect = h("select");
  for (const org of me.organizations) orgSelect.append(h("option", { value: org.id, textContent: org.name }));
  const projectSelect = h("select");
  const captureButton = h("button", { className: "primary", textContent: "Capture this page" });
  const status = h("div");

  const settings = await getSettings();
  const loadProjects = async () => {
    projectSelect.replaceChildren(h("option", { textContent: "Loading…", disabled: true }));
    let projects: Project[] = [];
    try {
      projects = await send({ type: "projects", organizationId: orgSelect.value });
    } catch (e) {
      status.replaceChildren(h("p", { className: "error", textContent: (e as Error).message }));
    }
    const capturable = projects.filter((p) => ["Editor", "Admin", "Owner"].includes(p.myRole));
    projectSelect.replaceChildren(...capturable.map((p) => h("option", { value: p.id, textContent: p.name, selected: p.id === settings.lastProjectId })));
    if (capturable.length === 0) projectSelect.append(h("option", { textContent: "No projects you can capture into", disabled: true, selected: true }));
    captureButton.disabled = capturable.length === 0;
  };
  orgSelect.onchange = loadProjects;

  captureButton.onclick = async () => {
    // Ask before any other await: Firefox only allows permission requests directly inside the click.
    // If access is already granted, this returns true without prompting.
    if (!(await chrome.permissions.request(SITE_ACCESS))) {
      status.replaceChildren(h("p", { className: "error", textContent: "Site access is needed to read the page's images and fonts." }));
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    captureButton.disabled = true;
    await send({ type: "capture", tabId: tab.id, projectId: projectSelect.value });
  };

  const showStatus = (s: CaptureStatus) => {
    captureButton.disabled = s.state === "working";
    switch (s.state) {
      case "idle":
        status.replaceChildren();
        break;
      case "working":
        status.replaceChildren(h("p", { className: "muted", textContent: s.step }), ...(s.progress === undefined ? [] : [h("progress", { value: s.progress, max: 1 })]));
        break;
      case "error":
        status.replaceChildren(h("p", { className: "error", textContent: s.message }));
        break;
      case "done": {
        const parts: Node[] = [h("p", { className: "ok", textContent: "Captured." })];
        if (s.failedResources > 0) parts.push(h("p", { className: "muted", textContent: `${s.failedResources} file(s) couldn't be fetched; the screenshot shows the page as it was.` }));
        parts.push(h("button", { textContent: "Open and annotate", onclick: () => void chrome.tabs.create({ url: new URL(`/snapshots/${s.snapshot.id}`, state.serverUrl!).href }) }));
        status.replaceChildren(...parts);
        break;
      }
    }
  };
  showStatus(state.status);
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.captureStatus?.newValue) showStatus(changes.captureStatus.newValue as CaptureStatus);
  });

  const live = state.liveSites.length > 0
    ? h("p", { className: "muted" }, "Live comments show on: ", ...state.liveSites.flatMap((origin, i) => [i ? ", " : "", h("code", { textContent: new URL(origin).host })]))
    : h("p", { className: "muted", textContent: "No live sites yet. A project Admin can add them in the project's settings in Inklayer." });
  render(h("label", {}, "Organisation", orgSelect), h("label", {}, "Project", projectSelect), captureButton, status, live, footer(state));
  await loadProjects();
}

function footer(state: StateResponse): HTMLElement {
  return h("div", { className: "row" },
    h("button", { className: "link", textContent: "Settings", onclick: () => renderSettings(state) }),
    h("button", { className: "link", textContent: "Sign out", onclick: async () => { await send({ type: "signOut" }); await refresh(); } }),
  );
}

async function renderSettings(state: StateResponse): Promise<void> {
  const settings = await getSettings();
  const mask = h("input", { placeholder: ".customer-name, [data-private]", value: settings.maskSelector ?? "" });
  const save = h("button", { className: "primary", textContent: "Save" });
  const message = h("p", { className: "error" });
  save.onclick = async () => {
    const selector = mask.value.trim();
    try {
      if (selector) document.querySelector(selector); // throws on invalid selectors
      await updateSettings({ maskSelector: selector || null });
      await refresh();
    } catch {
      message.textContent = "That isn't a valid CSS selector.";
    }
  };
  render(
    h("label", {}, "Hide personal data (CSS selector)", mask),
    h("p", { className: "muted", textContent: "Text and form values inside matching elements are replaced with dots before upload. Password fields are never captured." }),
    save,
    message,
    h("p", { className: "muted" }, "Server: ", h("code", { textContent: state.serverUrl ?? "" })),
    h("button", { className: "link", textContent: "Change server", onclick: () => renderSetup(state) }),
    h("button", { className: "link", textContent: "Back", onclick: refresh }),
  );
}

void refresh();
