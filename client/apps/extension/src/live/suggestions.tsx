/** @jsxImportSource preact */
import { decodeMentions, encodeMentions, type MentionPerson } from "@inklayer/overlay";
import type { ComponentChild } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { DocLookup, PersonLookup } from "../lib/live";
import { call } from "./call";

/**
 * Suggestions while typing in a comment or reply box: `[[` suggests docs (while docs are on), `@` suggests people in
 * the project's organisation. The text parsing is pure (`typedTrigger`, `applySuggestion`) and unit-tested;
 * `SuggestBox` is a textarea with the suggestion list under it.
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

/** What's written in a comment or reply box, and the people picked from @ suggestions there (name shown → id). */
export interface TextDraft {
  text: string;
  picked: ReadonlyMap<string, string>;
}

export const EMPTY_DRAFT: TextDraft = { text: "", picked: new Map() };

/** The text to save from a draft: trimmed, with picked @names as <@id>. */
export function draftBody(draft: TextDraft): string {
  return encodeMentions(draft.text.trim(), new Map(draft.picked));
}

/** A draft for editing saved text: its <@id> mentions shown as @names. */
export function draftOf(text: string, people: MentionPerson[]): TextDraft {
  const picked = new Map<string, string>();
  return { text: decodeMentions(text, people, picked), picked };
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

function SuggestionLabel({ item }: { item: Suggestion }) {
  if (item.kind === "doc") {
    return (
      <>
        <span>{item.doc.title}</span>
        {item.doc.folder && <span className="muted"> {item.doc.folder}</span>}
      </>
    );
  }
  const { displayName, fullName } = item.person;
  return (
    <>
      <span>@{displayName}</span>
      {fullName !== displayName && <span className="muted"> {fullName}</span>}
    </>
  );
}

export interface SuggestBoxProps {
  draft: TextDraft;
  onChange(draft: TextDraft): void;
  /** The organisation to suggest docs and people from; null for no suggestions. */
  organizationId(): string | null;
  docsOn: boolean;
  className?: string;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  /** Keys the suggestion list didn't use (it takes arrows, Enter, Tab and Escape while it's open). */
  onKeyDown?(e: KeyboardEvent): void;
  onClick?(e: MouseEvent): void;
}

/** A comment or reply box with suggestions: [[ for docs, @ for people. */
export function SuggestBox(props: SuggestBoxProps): ComponentChild {
  const { draft, onChange, organizationId, docsOn } = props;
  const box = useRef<HTMLTextAreaElement>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const timer = useRef(0);
  /** Where the cursor goes once a picked suggestion is in the text. */
  const cursor = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once, when the box appears
  useEffect(() => {
    if (props.autoFocus) box.current?.focus();
    return () => window.clearTimeout(timer.current);
  }, []);
  useLayoutEffect(() => {
    if (cursor.current === null || !box.current) return;
    box.current.setSelectionRange(cursor.current, cursor.current);
    box.current.focus();
    cursor.current = null;
  });

  const typed = () => {
    const el = box.current;
    return el ? typedTrigger(el.value.slice(0, el.selectionStart), docsOn) : null;
  };
  const pick = (item: Suggestion) => {
    const el = box.current;
    const at = typed();
    if (!el || !at) return;
    const next = applySuggestion(el.value, el.selectionStart, at.start, item);
    const picked = new Map(draft.picked);
    if (item.kind === "person") picked.set(item.person.displayName, item.person.id);
    cursor.current = next.cursor;
    setItems([]);
    onChange({ text: next.value, picked });
  };

  const onInput = (e: Event) => {
    onChange({ text: (e.currentTarget as HTMLTextAreaElement).value, picked: draft.picked });
    window.clearTimeout(timer.current);
    const at = typed();
    const org = organizationId();
    if (!at || !org) return setItems([]);
    timer.current = window.setTimeout(() => {
      lookup(at, org)
        .then((found) => {
          setItems(typed() === null ? [] : found);
          setActive(0);
        })
        .catch(() => undefined);
    }, LOOKUP_DELAY_MS);
  };

  // The list takes its keys before the box's own (Ctrl+Enter saves, Escape cancels).
  const onKeyDown = (e: KeyboardEvent) => {
    if (items.length > 0) {
      const item = items[active];
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        setActive((active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      } else if (((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab") && item) {
        pick(item);
      } else if (e.key === "Escape") {
        setItems([]);
      } else {
        return props.onKeyDown?.(e);
      }
      e.preventDefault();
      return;
    }
    props.onKeyDown?.(e);
  };

  return (
    <div className="suggest-wrap">
      <textarea
        ref={box}
        className={props.className}
        placeholder={props.placeholder}
        rows={props.rows}
        value={draft.text}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onClick={props.onClick}
        onBlur={() => window.setTimeout(() => setItems([]), HIDE_AFTER_BLUR_MS)}
      />
      <ul className="suggest" hidden={items.length === 0}>
        {items.map((item, i) => (
          <li
            key={item.kind === "doc" ? item.doc.id : item.person.id}
            className={i === active ? "active" : ""}
            onMouseDown={(e) => {
              e.preventDefault();
              pick(item);
            }}
          >
            <SuggestionLabel item={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}
