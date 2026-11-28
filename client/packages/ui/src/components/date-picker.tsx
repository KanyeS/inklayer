import { cn } from "cn";
import { CalendarDays, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/** yyyy-mm-dd for a date in this browser's time zone. */
function day(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return day(d);
}

/** Next Monday (or the Monday after, if today is Monday). */
function nextWeek(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return day(d);
}

/** "3 Dec", or "3 Dec 2027" in another year. */
export function formatDay(value: string): string {
  const [y = 1970, m = 1, d = 1] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(y !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}

export interface DatePickerProps {
  /** yyyy-mm-dd, or undefined for none. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Extra classes for the button's text, e.g. to show a date that's past. */
  tone?: string;
}

/** A date, picked with the browser's own calendar or a shortcut (today, tomorrow, next week), and cleared with ×. */
export function DatePicker({ value, onChange, disabled, placeholder = "None", className, tone }: DatePickerProps) {
  const shortcuts: [string, string][] = [
    ["Today", inDays(0)],
    ["Tomorrow", inDays(1)],
    ["Next week", nextWeek()],
    ["In 2 weeks", inDays(14)],
  ];
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-xl px-2 text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-60",
          !value && "text-muted-foreground",
          className,
        )}
      >
        <CalendarDays className="size-3.5 shrink-0" />
        <span className={tone}>{value ? formatDay(value) : placeholder}</span>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <input
          type="date"
          className="h-9 w-full rounded-xl border border-border bg-background px-2 text-sm"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
        <div className="mt-2 grid grid-cols-2 gap-1">
          {shortcuts.map(([label, date]) => (
            <button
              key={label}
              type="button"
              className="rounded-lg px-2 py-1 text-left text-sm hover:bg-muted"
              onClick={() => onChange(date)}
            >
              {label}
            </button>
          ))}
        </div>
        {value && (
          <button
            type="button"
            className="mt-1 flex w-full items-center gap-1 rounded-lg px-2 py-1 text-left text-sm text-muted-foreground hover:bg-muted"
            onClick={() => onChange(undefined)}
          >
            <X className="size-3.5" /> Clear
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
