import type { AnchorQuality } from "@inklayer/overlay";
import { useEffect, useRef, useState } from "react";
import type { Annotation } from "../lib/api";
import { dateTime, timeAgo } from "../lib/format";

const KIND_LABELS: Record<Annotation["kind"], string> = {
  Pin: "Comment", Element: "Element", Highlight: "Highlight", Rect: "Box", Arrow: "Arrow", Ink: "Drawing",
};

export function Composer({ onSave, onCancel, busy }: { onSave: (body: string) => void; onCancel: () => void; busy: boolean }) {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); onSave(body); }}>
      <textarea ref={ref} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a comment (optional)…" rows={3} maxLength={10000}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSave(body); if (e.key === "Escape") onCancel(); }} />
      <div className="row">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={busy}>Save</button>
      </div>
    </form>
  );
}

export function AnnotationItem({ annotation, label, quality, selected, canResolve, onSelect, onResolve, onEdit, onDelete }: {
  annotation: Annotation; label: number; quality: AnchorQuality | undefined; selected: boolean; canResolve: boolean;
  onSelect: () => void; onResolve: () => void; onEdit: (body: string) => void; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(annotation.body);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  const resolved = annotation.status === "Resolved";

  return (
    <li ref={ref} className={["annotation", selected ? "selected" : "", resolved ? "resolved" : ""].join(" ")} onClick={onSelect}>
      <div className="annotation-head">
        <span className="badge" style={{ background: annotation.color }}>{label}</span>
        <strong>{annotation.author.displayName}</strong>
        <span className="muted small" title={dateTime(annotation.createdAt)}>{timeAgo(annotation.createdAt)}</span>
        <span className="kind">{KIND_LABELS[annotation.kind]}</span>
      </div>
      {quality === "orphaned" && <p className="warn small">The page element this was attached to couldn't be found; it's shown where it originally was.</p>}
      {editing ? (
        <form onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onEdit(body); setEditing(false); }}>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={10000} autoFocus />
          <div className="row"><button type="button" onClick={() => setEditing(false)}>Cancel</button><button className="primary" type="submit">Save</button></div>
        </form>
      ) : (
        annotation.body ? <p className="body">{annotation.body}</p> : <p className="muted small">No comment</p>
      )}
      <div className="actions" onClick={(e) => e.stopPropagation()}>
        {canResolve && <button className="link" onClick={onResolve}>{resolved ? "Reopen" : "Resolve"}</button>}
        {annotation.canEdit && !editing && <button className="link" onClick={() => { setBody(annotation.body); setEditing(true); }}>Edit</button>}
        {annotation.canDelete && <button className="link danger" onClick={() => { if (confirm("Delete this annotation?")) onDelete(); }}>Delete</button>}
      </div>
    </li>
  );
}
