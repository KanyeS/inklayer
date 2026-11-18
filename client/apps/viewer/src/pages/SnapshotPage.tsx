import type { AnchorQuality, Draft, OverlayAnnotation, OverlayMessage, Tool } from "@inklayer/overlay";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnnotationItem, Composer } from "../components/AnnotationPanel";
import { ErrorText } from "../components/Layout";
import { COLORS, Toolbar } from "../components/Toolbar";
import { ApiError, atLeast, del, get, patch, post, type Annotation, type Project, type Snapshot } from "../lib/api";
import { dateTime, hostOf } from "../lib/format";
import { Link } from "../lib/router";
import { useAsync } from "../lib/useAsync";
import { useOverlay } from "../lib/useOverlay";

export function SnapshotPage({ snapshotId }: { snapshotId: string }) {
  const snapshot = useAsync(() => get<Snapshot>(`/api/snapshots/${snapshotId}`), [snapshotId]);
  const project = useAsync(async () => (snapshot.data ? get<Project>(`/api/projects/${snapshot.data.projectId}`) : undefined), [snapshot.data?.projectId]);
  const annotations = useAsync(() => get<Annotation[]>(`/api/snapshots/${snapshotId}/annotations`), [snapshotId]);

  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[0]!);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [quality, setQuality] = useState<Record<string, AnchorQuality>>({});
  const [showResolved, setShowResolved] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const role = project.data?.myRole;
  const canAnnotate = role ? atLeast(role, "Commenter") : false;
  const list = useMemo(() => annotations.data ?? [], [annotations.data]);
  const labels = useMemo(() => new Map(list.map((a, i) => [a.id, i + 1])), [list]);
  const visible = list.filter((a) => showResolved || a.status === "Open");

  const onMessage = useCallback((message: OverlayMessage) => {
    switch (message.type) {
      case "draft":
        setDraft(message.draft);
        setSelected(null);
        break;
      case "selected":
        setSelected(message.id);
        break;
      case "anchors":
        setQuality(message.quality);
        break;
    }
  }, []);
  const { frameRef, ready, send, resetReady } = useOverlay(onMessage);

  // Keep the overlay in sync with the viewer's state.
  useEffect(() => {
    if (!ready) return;
    const items: OverlayAnnotation[] = visible.map((a) => ({
      id: a.id, kind: a.kind, color: a.color, resolved: a.status === "Resolved", label: labels.get(a.id) ?? 0, anchor: a.anchor, geometry: a.geometry,
    }));
    send({ type: "setAnnotations", annotations: items });
  }, [ready, visible, labels, send]);
  useEffect(() => { if (ready) send({ type: "setTool", tool, color }); }, [ready, tool, color, send]);
  useEffect(() => { if (ready && snapshot.data) send({ type: "scrollTo", x: snapshot.data.scrollX, y: snapshot.data.scrollY }); }, [ready, snapshot.data, send]);

  // A new frame (e.g. a refreshed signed link) starts unready; its overlay announces itself with "ready".
  const viewUrl = snapshot.data?.viewUrl;
  useEffect(() => resetReady(), [viewUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (id: string) => {
    setSelected(id);
    send({ type: "select", id, scroll: true });
  };

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? new Error("Someone else changed this annotation. The list has been refreshed.") : (e as Error));
    } finally {
      setBusy(false);
      await annotations.reload();
    }
  };

  const save = (body: string) => run(async () => {
    if (!draft) return;
    const created = await post<Annotation>(`/api/snapshots/${snapshotId}/annotations`, {
      kind: draft.kind, body, color, anchor: draft.anchor, geometry: draft.geometry, viewportWidth: draft.viewportWidth,
    });
    setDraft(null);
    setSelected(created.id);
    setTool("select");
  });

  const cancelDraft = () => {
    setDraft(null);
    send({ type: "clearDraft" });
  };

  if (snapshot.error) return <div className="page"><ErrorText error={snapshot.error} /></div>;
  const s = snapshot.data;
  if (!s) return <div className="page muted">Loading…</div>;

  return (
    <div className="viewer">
      <div className="viewer-head">
        <div className="ellipsis">
          <Link to={`/projects/${s.projectId}`} className="muted">{project.data?.name ?? "Project"}</Link>
          <span className="muted"> / </span>
          <strong title={s.title}>{s.title || hostOf(s.url)}</strong>
          <a className="muted small url" href={s.url} target="_blank" rel="noreferrer noopener">{s.url}</a>
        </div>
        <span className="muted small">{s.capturedBy.displayName} · {dateTime(s.capturedAt)} · {s.viewportWidth}×{s.viewportHeight}</span>
      </div>
      <Toolbar tool={tool} color={color} canAnnotate={canAnnotate} onTool={setTool} onColor={setColor} />
      <div className="viewer-body">
        <div className="stage">
          {s.viewUrl ? (
            <iframe
              ref={frameRef}
              key={s.viewUrl}
              src={s.viewUrl}
              title={`Snapshot of ${s.url}`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              style={{ width: s.viewportWidth }}
            />
          ) : (
            <p className="error">Snapshot viewing isn't configured on this server (Inklayer:Snapshots:Origin).</p>
          )}
        </div>
        <aside className="panel">
          <div className="panel-head">
            <strong>Annotations ({list.length})</strong>
            <label className="small"><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved</label>
          </div>
          <ErrorText error={error ?? annotations.error} />
          {draft && <Composer busy={busy} onSave={(b) => void save(b)} onCancel={cancelDraft} />}
          {!draft && canAnnotate && list.length === 0 && <p className="muted small hint">Pick a tool above (or press C, E, H, R, A, D) and mark up the page.</p>}
          {!canAnnotate && <p className="muted small hint">You have view-only access to this project.</p>}
          <ul className="annotations">
            {visible.map((a) => (
              <AnnotationItem key={`${a.id}:${a.version}`} annotation={a} label={labels.get(a.id) ?? 0} quality={quality[a.id]} selected={a.id === selected}
                canResolve={canAnnotate}
                onSelect={() => select(a.id)}
                onResolve={() => void run(() => patch(`/api/annotations/${a.id}`, { version: a.version, status: a.status === "Open" ? "Resolved" : "Open" }))}
                onEdit={(body) => void run(() => patch(`/api/annotations/${a.id}`, { version: a.version, body }))}
                onDelete={() => void run(() => del(`/api/annotations/${a.id}?version=${a.version}`))} />
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
