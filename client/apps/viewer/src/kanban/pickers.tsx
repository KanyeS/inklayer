import { Popover, PopoverContent, PopoverTrigger } from "@inklayer/ui/components/popover";
import { cn } from "@inklayer/ui/lib/utils";
import { Check, Plus, UserRound } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { KanbanPerson } from "./kanbanApi";
import type { Task } from "./kanbanModel";

/** Up to two initials, for an avatar. */
function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

/** A stable colour per person, for avatars. */
export function personColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 55% 45%)`;
}

export function Avatar({ person, id, size = 22 }: { person?: KanbanPerson; id: string; size?: number }) {
  const name = person?.displayName ?? "Someone";
  return (
    <span
      className="kanban-avatar"
      title={
        person
          ? person.fullName && person.fullName !== name
            ? `${name} (${person.fullName})`
            : name
          : "Someone who's left"
      }
      style={{ width: size, height: size, fontSize: size * 0.42, background: personColor(id) }}
    >
      {initials(name)}
    </span>
  );
}

/** Avatars side by side, overlapping a little; "+2" past `max`. */
export function Avatars({
  ids,
  people,
  max = 3,
  size,
}: {
  ids: string[];
  people: Map<string, KanbanPerson>;
  max?: number;
  size?: number;
}) {
  if (ids.length === 0) return null;
  return (
    <span className="kanban-avatars">
      {ids.slice(0, max).map((id) => (
        <Avatar key={id} id={id} person={people.get(id)} size={size} />
      ))}
      {ids.length > max && <span className="kanban-avatar-more">+{ids.length - max}</span>}
    </span>
  );
}

/** A filterable list in a popover: type to narrow it, Enter picks the first. */
export function PickerList<T>({
  items,
  query,
  onQuery,
  label,
  render,
  isSelected,
  onPick,
  placeholder,
  extra,
}: {
  items: T[];
  query: string;
  onQuery: (q: string) => void;
  label: (item: T) => string;
  render: (item: T) => ReactNode;
  isSelected: (item: T) => boolean;
  onPick: (item: T) => void;
  placeholder: string;
  extra?: ReactNode;
}) {
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? items.filter((i) => label(i).toLowerCase().includes(q)) : items).slice(0, 50);
  }, [items, query, label]);
  return (
    <div>
      <input
        // biome-ignore lint/a11y/noAutofocus: the picker just opened, to type a name
        autoFocus
        className="mb-1 h-8 w-full rounded-lg border border-border bg-background px-2 text-sm outline-none focus:border-ring"
        placeholder={placeholder}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && shown[0]) {
            e.preventDefault();
            onPick(shown[0]);
          }
        }}
      />
      <ul className="max-h-64 overflow-y-auto">
        {shown.map((item) => (
          <li key={label(item)}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => onPick(item)}
            >
              <span className="min-w-0 flex-1 truncate">{render(item)}</span>
              {isSelected(item) && <Check className="size-3.5 shrink-0 text-primary" />}
            </button>
          </li>
        ))}
        {shown.length === 0 && !extra && <li className="px-2 py-1.5 text-sm text-muted-foreground">No matches</li>}
      </ul>
      {extra}
    </div>
  );
}

/** Who a task is assigned to: anyone who can open the kanban. */
export function PeoplePicker({
  value,
  onChange,
  people,
  meId,
  disabled,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  people: Map<string, KanbanPerson>;
  meId: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const list = useMemo(() => {
    const all = [...people.values()];
    // Me first, then the rest by name.
    return all.sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : a.displayName.localeCompare(b.displayName)));
  }, [people, meId]);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <Popover onOpenChange={(open) => !open && setQuery("")}>
      <PopoverTrigger
        disabled={disabled}
        className="flex min-h-8 w-full flex-wrap items-center gap-1.5 rounded-xl px-2 py-1 text-left text-sm hover:bg-muted disabled:pointer-events-none"
      >
        {value.length === 0 ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <UserRound className="size-3.5" /> Unassigned
          </span>
        ) : (
          value.map((id) => (
            <span key={id} className="flex items-center gap-1.5">
              <Avatar id={id} person={people.get(id)} size={20} />
              {people.get(id)?.displayName ?? "Someone"}
            </span>
          ))
        )}
      </PopoverTrigger>
      <PopoverContent>
        <PickerList
          items={list}
          query={query}
          onQuery={setQuery}
          label={(p) => `${p.displayName} ${p.fullName}`}
          placeholder="Find a person"
          isSelected={(p) => value.includes(p.id)}
          onPick={(p) => toggle(p.id)}
          render={(p) => (
            <span className="flex items-center gap-2">
              <Avatar id={p.id} person={p} size={20} />
              {p.displayName}
              {p.id === meId && <span className="text-xs text-muted-foreground">(me)</span>}
            </span>
          )}
        />
        {!value.includes(meId) && people.has(meId) && (
          <button
            type="button"
            className="mt-1 w-full rounded-lg px-2 py-1 text-left text-sm text-primary hover:bg-muted"
            onClick={() => toggle(meId)}
          >
            Assign to me
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** A task's tags: the organisation's tags to pick from, or a new one typed in. */
export function TagPicker({
  value,
  onChange,
  known,
  disabled,
  children,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  known: string[];
  disabled?: boolean;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const clean = (t: string) =>
    t
      .trim()
      .replace(/^#+/, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_/-]+/gu, "-")
      .replace(/^-+|-+$/g, "");
  const typed = clean(query);
  const all = useMemo(() => [...new Set([...value, ...known])].sort(), [value, known]);
  const toggle = (tag: string) => onChange(value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag]);
  const canAdd = typed.length > 0 && /\p{L}|_/u.test(typed) && !all.includes(typed);
  return (
    <Popover onOpenChange={(open) => !open && setQuery("")}>
      <PopoverTrigger
        disabled={disabled}
        className="flex min-h-8 w-full flex-wrap items-center gap-1 rounded-xl px-2 py-1 text-left text-sm hover:bg-muted disabled:pointer-events-none"
      >
        {children}
      </PopoverTrigger>
      <PopoverContent>
        <PickerList
          items={all}
          query={query}
          onQuery={setQuery}
          label={(t) => t}
          placeholder="Find or add a tag"
          isSelected={(t) => value.includes(t)}
          onPick={(t) => (canAdd && t !== typed ? toggle(typed) : toggle(t))}
          render={(t) => `#${t}`}
          extra={
            canAdd && (
              <button
                type="button"
                className="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => {
                  toggle(typed);
                  setQuery("");
                }}
              >
                <Plus className="size-3.5" /> Add #{typed}
              </button>
            )
          }
        />
      </PopoverContent>
    </Popover>
  );
}

/** Picks one task on the kanban, by key or title. */
export function TaskPicker({
  tasks,
  onPick,
  children,
  disabled,
  title,
}: {
  tasks: Task[];
  onPick: (task: Task) => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        title={title}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:hidden",
        )}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <PickerList
          items={tasks}
          query={query}
          onQuery={setQuery}
          label={(t) => `${t.key} ${t.title}`}
          placeholder="Find a task by key or title"
          isSelected={() => false}
          onPick={(t) => {
            onPick(t);
            setOpen(false);
          }}
          render={(t) => (
            <>
              <span className="mr-1.5 font-mono text-xs text-muted-foreground">{t.key}</span>
              {t.title}
            </>
          )}
        />
      </PopoverContent>
    </Popover>
  );
}
