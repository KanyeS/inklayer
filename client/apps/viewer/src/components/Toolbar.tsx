import type { Tool } from "@inklayer/overlay";
import { useEffect } from "react";

export const COLORS = ["#f59e0b", "#ef4444", "#3b82f6", "#10b981", "#8b5cf6", "#111827"];

const TOOLS: { tool: Tool; label: string; key: string; icon: string }[] = [
  { tool: "select", label: "Select", key: "v", icon: "↖" },
  { tool: "pin", label: "Comment pin", key: "c", icon: "📍" },
  { tool: "element", label: "Element", key: "e", icon: "⬚" },
  { tool: "highlight", label: "Highlight text", key: "h", icon: "🖍" },
  { tool: "rect", label: "Rectangle", key: "r", icon: "▭" },
  { tool: "arrow", label: "Arrow", key: "a", icon: "↗" },
  { tool: "ink", label: "Draw", key: "d", icon: "✎" },
];

export function Toolbar({ tool, color, canAnnotate, onTool, onColor }: {
  tool: Tool; color: string; canAnnotate: boolean; onTool: (t: Tool) => void; onColor: (c: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || target.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape") return onTool("select");
      const match = TOOLS.find((t) => t.key === e.key.toLowerCase());
      if (match && (canAnnotate || match.tool === "select")) onTool(match.tool);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canAnnotate, onTool]);

  return (
    <div className="toolbar" role="toolbar" aria-label="Annotation tools">
      {TOOLS.map((t) => (
        <button key={t.tool} className={tool === t.tool ? "tool active" : "tool"} disabled={!canAnnotate && t.tool !== "select"}
          title={`${t.label} (${t.key.toUpperCase()})`} aria-pressed={tool === t.tool} onClick={() => onTool(t.tool)}>
          <span aria-hidden>{t.icon}</span><span className="tool-label">{t.label}</span>
        </button>
      ))}
      <span className="sep" />
      {COLORS.map((c) => (
        <button key={c} className={c === color ? "swatch active" : "swatch"} style={{ background: c }} title={c} aria-label={`Colour ${c}`}
          disabled={!canAnnotate} onClick={() => onColor(c)} />
      ))}
    </div>
  );
}
