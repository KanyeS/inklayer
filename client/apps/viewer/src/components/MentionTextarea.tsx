import type { PersonResponse } from "@inklayer/api";
import { encodeMentions } from "@inklayer/overlay";
import { Textarea } from "@inklayer/ui/components/textarea";
import { type ComponentProps, forwardRef, type KeyboardEvent, useImperativeHandle, useRef, useState } from "react";
import { lookupPeople } from "@/lib/api";

type Person = PersonResponse;

export interface MentionTextareaHandle {
  /** The text with @Name turned back into <@id> for people picked from the suggestions. */
  encoded(): string;
}

/** A textarea where typing @ suggests people in the organisation. Shows "@Name" while typing; saves <@id>. */
export const MentionTextarea = forwardRef<
  MentionTextareaHandle,
  ComponentProps<typeof Textarea> & { orgId: string; value: string; onValueChange: (value: string) => void }
>(function MentionTextarea({ orgId, value, onValueChange, onKeyDown, ...rest }, ref) {
  const box = useRef<HTMLTextAreaElement>(null);
  const picked = useRef(new Map<string, string>());
  const [people, setPeople] = useState<Person[]>([]);
  const [active, setActive] = useState(0);
  const timer = useRef(0);

  useImperativeHandle(ref, () => ({ encoded: () => encodeMentions(value, picked.current) }), [value]);

  const typed = (text: string, caret: number) => /(?:^|\s)@([^\s@<>]{0,30})$/.exec(text.slice(0, caret));

  const onChange = (text: string, caret: number) => {
    onValueChange(text);
    window.clearTimeout(timer.current);
    const at = typed(text, caret);
    if (!at) return setPeople([]);
    timer.current = window.setTimeout(() => {
      lookupPeople(orgId, at[1] ?? "")
        .then((found) => {
          setPeople(found);
          setActive(0);
        })
        .catch(() => setPeople([]));
    }, 150);
  };

  const pick = (person: Person) => {
    const el = box.current!;
    const caret = el.selectionStart;
    const at = typed(value, caret);
    if (!at) return;
    const start = caret - at[1]!.length - 1;
    const insert = `@${person.displayName} `;
    picked.current.set(person.displayName, person.id);
    onValueChange(value.slice(0, start) + insert + value.slice(caret));
    setPeople([]);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + insert.length, start + insert.length);
    });
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (people.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : people.length - 1)) % people.length);
        return;
      }
      if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
        e.preventDefault();
        pick(people[active]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPeople([]);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="relative">
      <Textarea
        {...rest}
        ref={box}
        value={value}
        onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
        onKeyDown={keyDown}
        onBlur={() => window.setTimeout(() => setPeople([]), 150)}
      />
      {people.length > 0 && (
        <ul className="absolute top-full left-0 z-10 mt-1 w-72 rounded-xl border bg-popover p-1 text-sm shadow-lg">
          {people.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(p);
                }}
                className={`flex w-full justify-between gap-2 rounded-lg px-2 py-1 text-left ${i === active ? "bg-muted" : ""}`}
              >
                <span>@{p.displayName}</span>
                {p.fullName !== p.displayName && <span className="truncate text-muted-foreground">{p.fullName}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
