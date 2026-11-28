import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { EditorHooks, PersonLookup } from "./hooks";

/**
 * Suggestions while typing: [[ suggests docs, @ suggests people. Choosing the options is pure (`linkOptions`,
 * `mentionOptions`) and unit-tested in test/editor.test.ts; the rest plugs them into CodeMirror.
 */

/** How long a people lookup is reused (see mentionCompletion). */
const LOOKUP_REUSE_MS = 30_000;
const LINK_TYPED = /\[\[[^[\]\n|#]*$/;
const LINK_VALID = /^[^[\]\n|#]*$/;
const MENTION_TYPED = /(?:^|\s)@[^\s@<>[\]]{0,30}$/;
const TASK_TYPED = /\[\[task:[^[\]\n|]*$/i;

export interface LinkOption {
  /** What gets inserted: the title, or folder/title when two docs share the title. */
  target: string;
  folder: string;
}

/** The docs to suggest after [[, each with the text that links it unambiguously. */
export function linkOptions(docs: { title: string; folder: string }[]): LinkOption[] {
  const counts = new Map<string, number>();
  for (const d of docs) counts.set(d.title.toLowerCase(), (counts.get(d.title.toLowerCase()) ?? 0) + 1);
  return docs.map((d) => {
    const shared = (counts.get(d.title.toLowerCase()) ?? 0) > 1;
    return { target: shared && d.folder ? `${d.folder}/${d.title}` : d.title, folder: d.folder };
  });
}

/** Whether to offer to create a doc called what was typed (no doc has that title yet). */
export function offerNewDoc(typed: string, docs: { title: string }[]): boolean {
  const title = typed.trim().toLowerCase();
  return title !== "" && !docs.some((d) => d.title.toLowerCase() === title);
}

/** The people to suggest after @: their name, real name if different, and the <@id> that's inserted. */
export function mentionOptions(people: PersonLookup[]): Completion[] {
  return people.map((p) => ({
    label: `@${p.displayName}`,
    detail: p.fullName !== p.displayName ? p.fullName : undefined,
    apply: `<@${p.id}> `,
  }));
}

/** [[ suggests docs; picking one closes the link (unless it's closed already) and moves past it. */
export function linkCompletion(hooks: EditorHooks) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(LINK_TYPED);
    if (!before) return null;
    const typed = before.text.slice(2);
    if (/^task:/i.test(typed)) return null; // taskCompletion's
    const docs = hooks.titles();
    const options: Completion[] = linkOptions(docs).map(({ target, folder }) => ({
      label: target,
      detail: folder || undefined,
      apply: (view, _completion, from, to) => {
        const closed = view.state.sliceDoc(to, to + 2) === "]]";
        view.dispatch({
          changes: { from, to, insert: closed ? target : `${target}]]` },
          selection: { anchor: from + target.length + 2 },
        });
      },
    }));
    if (offerNewDoc(typed, docs)) options.push({ label: typed.trim(), detail: "new doc", boost: -99 });
    return { from: before.from + 2, options, validFor: LINK_VALID };
  };
}

/** [[task: suggests tasks by key or title; picking one writes its key and closes the link. */
export function taskCompletion(hooks: EditorHooks) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const before = context.matchBefore(TASK_TYPED);
    if (!before || !hooks.tasks) return null;
    const from = before.from + "[[task:".length;
    const tasks = await hooks.tasks(before.text.slice("[[task:".length).trim()).catch(() => []);
    return {
      from,
      filter: false,
      options: tasks.map((t) => ({
        label: `${t.key} ${t.title}`,
        detail: t.detail,
        apply: (view, _completion, start, to) => {
          const closed = view.state.sliceDoc(to, to + 2) === "]]";
          view.dispatch({
            changes: { from: start, to, insert: closed ? t.key : `${t.key}]]` },
            selection: { anchor: start + t.key.length + 2 },
          });
        },
      })),
    };
  };
}

/** Typing @ suggests people in the organisation; picking one inserts <@id>, shown as their name. */
export function mentionCompletion(hooks: EditorHooks) {
  // Lookups are kept for a while: when a collaborator's edit cancels a lookup halfway, CodeMirror asks again, and the
  // second ask then gets the answer already on its way instead of starting over (and being cancelled again).
  const lookups = new Map<string, { at: number; people: Promise<PersonLookup[]> }>();
  const lookUp = (people: NonNullable<EditorHooks["people"]>, query: string) => {
    const key = query.toLowerCase();
    const cached = lookups.get(key);
    if (cached && Date.now() - cached.at < LOOKUP_REUSE_MS) return cached.people;
    const found = people(query);
    lookups.set(key, { at: Date.now(), people: found });
    found.catch(() => lookups.delete(key));
    return found;
  };
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const before = context.matchBefore(MENTION_TYPED);
    if (!before || !hooks.people) return null;
    const at = before.text.indexOf("@");
    const people = await lookUp(hooks.people, before.text.slice(at + 1));
    return { from: before.from + at, filter: false, options: mentionOptions(people) };
  };
}
