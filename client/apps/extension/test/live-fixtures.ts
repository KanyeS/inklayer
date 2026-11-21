import { type ComponentChild, render } from "preact";
import { vi } from "vitest";
import type { Features } from "../src/lib/api";
import type { LiveInit, LiveProject } from "../src/lib/live";
import type { PageAnnotation, PanelContext } from "../src/live/context";

/** Test data and fakes for the live panel's views and session. */

export const ALL_FEATURES: Features = {
  docs: true,
  liveCursors: true,
  mcp: true,
  bugContext: true,
  issueTrackers: true,
  sharing: true,
};

export function project(overrides: Partial<LiveProject> = {}): LiveProject {
  return {
    id: "p1",
    name: "Website",
    organizationId: "o1",
    organizationName: "Acme",
    myRole: "Commenter",
    canComment: true,
    ...overrides,
  };
}

export function annotation(overrides: Partial<PageAnnotation> = {}): PageAnnotation {
  return {
    id: "a1",
    projectId: "p1",
    pageUrl: "https://site.test/page",
    kind: "Pin",
    status: "Open",
    body: "Fix this",
    color: "#ef4444",
    anchor: {
      element: {
        path: ["body"],
        xpath: "/html/body",
        tag: "body",
        text: "",
        box: { x: 0, y: 0, width: 800, height: 600 },
      },
    },
    geometry: { kind: "Pin", point: { x: 0.5, y: 0.5 } },
    version: 1,
    author: { id: "u1", displayName: "Ann", fullName: "Ann Lee", avatarUrl: null, role: "Commenter" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedByUserId: null,
    viewportWidth: 0,
    canEdit: true,
    canDelete: true,
    organizationId: "o1",
    ...overrides,
  };
}

export function init(overrides: Partial<LiveInit> = {}): LiveInit {
  return {
    projects: [project()],
    pages: [],
    lastProjectId: null,
    serverUrl: "https://ink.test",
    features: ALL_FEATURES,
    pullRequest: null,
    ...overrides,
  };
}

/** A panel context that records what views ask it to do. */
export function fakeContext(overrides: { init?: LiveInit; busy?: boolean; onThisPage?: string[] } = {}) {
  const ctx = {
    init: overrides.init ?? init(),
    busy: overrides.busy ?? false,
    render: vi.fn(),
    mutate: vi.fn((action: () => Promise<unknown>) => void action().catch(() => undefined)),
    flashNote: vi.fn(),
    showError: vi.fn(),
    isOnThisPage: (id: string) => (overrides.onThisPage ?? []).includes(id),
    showOnPage: vi.fn(),
  } satisfies PanelContext;
  return ctx;
}

/** A fake `chrome` for the content script: answers runtime messages with `answer`, and keeps storage in memory. */
export function fakeChrome(answer: (message: { type: string }) => unknown = () => null) {
  const stored: Record<string, unknown> = {};
  const listeners: ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];
  const sendMessage = vi.fn(async (message: { type: string }) => ({ ok: true, value: answer(message) }));
  return {
    stored,
    sendMessage,
    chrome: {
      runtime: { sendMessage, id: "ext", onMessage: { addListener: vi.fn() } },
      storage: {
        local: {
          get: vi.fn(async () => ({ ...stored })),
          set: vi.fn(async (values: Record<string, unknown>) => {
            Object.assign(stored, values);
          }),
        },
        onChanged: { addListener: (l: (typeof listeners)[number]) => listeners.push(l) },
      },
    },
  };
}

/** Text of every element matching a selector. */
export function texts(root: ParentNode, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((el) => el.textContent ?? "");
}

/** Clicks the button whose text is `label`. */
export function clickButton(root: ParentNode, label: string): void {
  const button = [...root.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!button) throw new Error(`No "${label}" button`);
  button.click();
}

/** Renders panel content into a new element in the document, and returns that element. */
export function mount(content: ComponentChild): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  render(content, root);
  return root;
}

/** Renders panel content and returns the first element it made. */
export function mountOne(content: ComponentChild): HTMLElement {
  const el = mount(content).firstElementChild;
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) throw new Error("Nothing was rendered");
  return el as HTMLElement;
}
