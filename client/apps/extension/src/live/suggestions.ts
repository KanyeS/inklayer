import { h } from "@inklayer/overlay";
import type { DocLookup, PersonLookup } from "../lib/live";
import { call } from "./call";

/**
 * Suggestions while typing in a comment or reply box: `[[` suggests docs (while docs are on), `@` suggests people in
 * the project's organisation. The text parsing is pure (`typedTrigger`, `applySuggestion`) and unit-tested; the rest
 * wires it to a textarea.
 */

export type Suggestion = { kind: "doc"; doc: DocLookup } | { kind: "person"; person: PersonLookup };

/** What's being typed at the cursor: a doc link or a mention, the text typed so far, and where it starts. */
export interface Trigger {
  kind: "doc" | "person";
  query: string;
  start: number;
}

const DOC_TRIGGER = /\[\[([^[\]\n|#]*)$/;
const PERSON_TRIGGER = /(?:^|\s)@([^\s@<>]{0,30})$/;
const LOOKUP_DELAY_MS = 150;
const HIDE_AFTER_BLUR_MS = 150;

/** The doc link or mention being typed at the end of `before` (the text up to the cursor), or null. */
export function typedTrigger(before: string, docsOn: boolean): Trigger | null {
  const doc = docsOn ? DOC_TRIGGER.exec(before) : null;
  if (doc) return { kind: "doc", query: doc[1] ?? "", start: before.length - doc[0].length };
  const person = PERSON_TRIGGER.exec(before);
  if (!person) return null;
  const query = person[1] ?? "";
  return { kind: "person", query, start: before.length - query.length - 1 };
}

/**
 * The box's text with a suggestion put in place of what was typed, and where the cursor goes. A doc link is closed
 * with `]]` unless the text after the cursor already closes it (then the cursor jumps past it).
 */
export function applySuggestion(
  value: string,
  cursor: number,
  start: number,
  item: Suggestion,
): { value: string; cursor: number } {
  const after = value.slice(cursor);
  const closed = item.kind === "doc" && after.startsWith("]]");
  const insert = item.kind === "doc" ? `[[${item.doc.title}${closed ? "" : "]]"}` : `@${item.person.displayName} `;
  return { value: value.slice(0, start) + insert + after, cursor: start + insert.length + (closed ? 2 : 0) };
}

/** People picked from @ suggestions in each box, by the name shown, so "@Name" can be saved as <@id>. */
const pickedPeople = new WeakMap<HTMLTextAreaElement, Map<string, string>>();

/** The people picked in a box so far (display name → id). */
export function pickedIn(input: HTMLTextAreaElement): Map<string, string> {
  let picked = pickedPeople.get(input);
  if (!picked) {
    picked = new Map();
    pickedPeople.set(input, picked);
  }
  return picked;
}

function lookup(trigger: Trigger, orgId: string): Promise<Suggestion[]> {
  if (trigger.kind === "doc") {
    return call<DocLookup[]>({ type: "live.docs", orgId, q: trigger.query }).then((docs) =>
      docs.map((doc): Suggestion => ({ kind: "doc", doc })),
    );
  }
  return call<PersonLookup[]>({ type: "live.people", orgId, q: trigger.query }).then((people) =>
    people.map((person): Suggestion => ({ kind: "person", person })),
  );
}

function suggestionLabel(item: Suggestion): Node[] {
  if (item.kind === "doc") {
    const folder = item.doc.folder ? h("span", { className: "muted", textContent: ` ${item.doc.folder}` }) : null;
    return [h("span", { textContent: item.doc.title }), ...(folder ? [folder] : [])];
  }
  const { displayName, fullName } = item.person;
  const real = fullName !== displayName ? h("span", { className: "muted", textContent: ` ${fullName}` }) : null;
  return [h("span", { textContent: `@${displayName}` }), ...(real ? [real] : [])];
}

/** The suggestion list for each comment box, kept with the box across re-renders. */
const suggestionLists = new WeakMap<HTMLTextAreaElement, HTMLUListElement>();

/**
 * Adds suggestions to a comment or reply box (once; later calls reuse them) and returns the box wrapped with its
 * suggestion list.
 */
export function withSuggestions(
  input: HTMLTextAreaElement,
  organizationId: () => string | null,
  docsOn: boolean,
): HTMLElement {
  let list = suggestionLists.get(input);
  if (!list) {
    list = attachSuggestions(input, organizationId, docsOn);
    suggestionLists.set(input, list);
  }
  return h("div", { className: "suggest-wrap" }, input, list);
}

function attachSuggestions(
  input: HTMLTextAreaElement,
  organizationId: () => string | null,
  docsOn: boolean,
): HTMLUListElement {
  const ul = h("ul", { className: "suggest" });
  ul.hidden = true;
  let items: Suggestion[] = [];
  let active = 0;
  let timer = 0;

  const typed = () => typedTrigger(input.value.slice(0, input.selectionStart), docsOn);
  const show = () => {
    ul.replaceChildren(
      ...items.map((item, i) =>
        h(
          "li",
          {
            className: i === active ? "active" : "",
            onmousedown: (e: Event) => {
              e.preventDefault();
              pick(item);
            },
          },
          ...suggestionLabel(item),
        ),
      ),
    );
    ul.hidden = items.length === 0;
  };
  const clear = () => {
    items = [];
    show();
  };
  const pick = (item: Suggestion) => {
    const at = typed();
    if (!at) return;
    if (item.kind === "person") pickedIn(input).set(item.person.displayName, item.person.id);
    const next = applySuggestion(input.value, input.selectionStart, at.start, item);
    input.value = next.value;
    input.setSelectionRange(next.cursor, next.cursor);
    clear();
    input.focus();
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const at = typed();
    const org = organizationId();
    if (!at || !org) return clear();
    timer = window.setTimeout(() => {
      lookup(at, org)
        .then((found) => {
          items = typed() === null ? [] : found;
          active = 0;
          show();
        })
        .catch(() => undefined);
    }, LOOKUP_DELAY_MS);
  });

  // Before the box's own keys (Ctrl+Enter saves, Escape cancels).
  input.addEventListener(
    "keydown",
    (e) => {
      if (ul.hidden) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        show();
      } else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
        const item = items[active];
        if (item) pick(item);
      } else if (e.key === "Escape") {
        clear();
      } else {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  input.addEventListener("blur", () => window.setTimeout(clear, HIDE_AFTER_BLUR_MS));
  return ul;
}
