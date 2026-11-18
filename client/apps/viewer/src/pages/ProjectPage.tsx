import { ErrorText } from "../components/Layout";
import { get, type Project, type SnapshotSummary } from "../lib/api";
import { hostOf, timeAgo } from "../lib/format";
import { Link } from "../lib/router";
import { useAsync } from "../lib/useAsync";

export function ProjectPage({ projectId }: { projectId: string }) {
  const project = useAsync(() => get<Project>(`/api/projects/${projectId}`), [projectId]);
  const snapshots = useAsync(() => get<SnapshotSummary[]>(`/api/projects/${projectId}/snapshots?limit=200`), [projectId]);

  if (project.error) return <div className="page"><ErrorText error={project.error} /></div>;
  if (!project.data) return <div className="page muted">Loading…</div>;

  return (
    <div className="page">
      <p className="crumbs"><Link to={`/orgs/${project.data.organizationId}`}>Organisation</Link> /</p>
      <h1>{project.data.name} <span className="pill">{project.data.myRole}</span></h1>
      <ErrorText error={snapshots.error} />
      {snapshots.data?.length === 0 && (
        <div className="empty">
          <p>No snapshots yet.</p>
          <p className="muted">Install the Inklayer browser extension, open a page, and choose "Capture this page".</p>
        </div>
      )}
      <ul className="grid">
        {snapshots.data?.map((s) => (
          <li key={s.id}>
            <Link to={`/snapshots/${s.id}`} className="card snapshot-card">
              <div className="thumb">{s.hasScreenshot ? <img src={`/api/snapshots/${s.id}/screenshot`} alt="" loading="lazy" /> : <span className="muted">No screenshot</span>}</div>
              <strong className="ellipsis">{s.title || hostOf(s.url)}</strong>
              <span className="muted small ellipsis">{hostOf(s.url)} · {s.capturedBy.displayName} · {timeAgo(s.capturedAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
