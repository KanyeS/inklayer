import { Button } from "@inklayer/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@inklayer/ui/components/dialog";
import { Input } from "@inklayer/ui/components/input";
import { cn } from "@inklayer/ui/lib/utils";
import { Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { DEFAULT_ICONS, ICON_COLORS, IconSvg, useIcons } from "./docIcons";

/** How many icons the grid shows at once; typing narrows it down. */
const SHOWN = 300;

export interface Appearance {
  icon: string | null;
  color: string | null;
}

/**
 * Choose a doc's icon from the whole Lucide set (search by name) and its colour (a swatch or any colour). Each choice
 * takes effect straight away through `onChange`; "Use defaults" clears both.
 */
export function IconPicker({
  open,
  onOpenChange,
  value,
  onChange,
  title = "Icon and colour",
  description = "Shown for this doc in the graph and the sidebar.",
  defaultIcon = DEFAULT_ICONS.doc,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: Appearance;
  onChange: (next: Appearance) => void;
  title?: string;
  description?: string;
  /** The icon shown when none is chosen; null when having no icon is the default (tags). */
  defaultIcon?: string | null;
}) {
  const library = useIcons();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const color = value.color ?? ICON_COLORS[0]!;

  const matches = useMemo(() => {
    if (!library) return [];
    const words = deferred.split(/[\s-]+/).filter(Boolean);
    return library.all.filter((e) => words.every((w) => e.search.includes(w)));
  }, [library, deferred]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Colour">
          {ICON_COLORS.map((c) => (
            // biome-ignore lint/a11y/useSemanticElements: a colour swatch acting as a radio; a native radio can't look like one
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={c}
              title={c}
              className={cn(
                "size-6 rounded-full border-2 border-background ring-1 ring-border transition-transform hover:scale-110",
                color === c && "ring-2 ring-foreground",
              )}
              style={{ background: c }}
              onClick={() => onChange({ ...value, color: c })}
            />
          ))}
          <label
            className="relative ml-1 flex size-6 cursor-pointer items-center justify-center rounded-full ring-1 ring-border"
            title="Any colour"
            style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}
          >
            <span className="sr-only">Any colour</span>
            <input
              type="color"
              className="absolute inset-0 cursor-pointer opacity-0"
              value={color}
              onChange={(e) => onChange({ ...value, color: e.target.value })}
            />
          </label>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            className="pl-9"
            placeholder={library ? `Search ${library.all.length.toLocaleString()} icons…` : "Loading icons…"}
            aria-label="Search icons"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div
          className="grid max-h-80 grid-cols-8 gap-1 overflow-y-auto pr-1 sm:grid-cols-10"
          role="listbox"
          aria-label="Icons"
        >
          {matches.slice(0, SHOWN).map((entry) => {
            const selected = (value.icon ?? defaultIcon) === entry.name;
            return (
              <button
                key={entry.name}
                type="button"
                role="option"
                aria-selected={selected}
                title={entry.name}
                className={cn(
                  "flex aspect-square items-center justify-center rounded-lg transition-colors hover:bg-muted",
                  selected && "bg-muted ring-2 ring-ring",
                )}
                onClick={() => onChange({ ...value, icon: entry.name })}
              >
                <IconSvg node={entry.node} className="size-5" style={{ color }} />
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {!library
            ? ""
            : matches.length === 0
              ? "No icons match."
              : matches.length > SHOWN
                ? `Showing ${SHOWN} of ${matches.length.toLocaleString()}. Type to narrow it down.`
                : `${matches.length} icons`}
        </p>

        <div className="flex justify-between gap-2">
          <div className="flex gap-1">
            <Button variant="ghost" onClick={() => onChange({ icon: null, color: null })}>
              Use defaults
            </Button>
            {defaultIcon === null && value.icon && (
              <Button variant="ghost" onClick={() => onChange({ ...value, icon: null })}>
                No icon
              </Button>
            )}
          </div>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
