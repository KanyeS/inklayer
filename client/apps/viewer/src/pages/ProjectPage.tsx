import { useState, type FormEvent } from "react";
import { ErrorText } from "../components/Layout";
import { atLeast, get, patch, type LivePageSummary, type Project, type SnapshotSummary } from "../lib/api";
import { hostOf, timeAgo } from "../lib/format";
import { Link } from "../lib/router";
import { useAsync } from "../lib/useAsync";

type Tab = "snapshots" | "live" | "settings";

export function ProjectPage({ projectId }: { projectId: string }) {
  const project = useAsync(() => get<Project>(`/api/projects/${projectId}`), [projectId]);
  const [tab, setTab] = useState<Tab>("snapshots");

  if (project.error) return <div className="page"><ErrorText error={project.error} /></div>;
  if (!project.data) return <div className="page muted">Loading…</div>;
  const isAdmin = atLeast(project.data.myRole, "Admin");

  return (
    <div className="page">
      <p className="crumbs"><Link to={`/orgs/${project.data.organizationId}`}>Organisation</Link> /</p>
      <h1>{project.data.name} <span className="pill">{project.data.myRole}</span></h1>
      <div className="tabs">
        <button className={tab === "snapshots" ? "active" : ""} onClick={() => setTab("snapshots")}>Snapshots</button>
        <button className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>Live pages</button>
        {isAdmin && <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>}
      </div>
      {tab === "snapshots" && <Snapshots projectId={projectId} />}
      {tab === "live" && <LivePages project={project.data} />}
      {tab === "settings" && isAdmin && <Settings project={project.data} onSaved={project.reload} />}
    </div>
  );
}

function Snapshots({ projectId }: { projectId: string }) {
  const snapshots = useAsync(() => get<SnapshotSummary[]>(`/api/projects/${projectId}/snapshots?limit=200`), [projectId]);
  return (
    <>
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
    </>
  );
}

/** Real pages with comments in this project. Opening one shows the comments on the page itself, through the extension. */
function LivePages({ project }: { project: Project }) {
  const pages = useAsync(() => get<LivePageSummary[]>(`/api/projects/${project.id}/live/pages`), [project.id]);

  return (
    <>
      <p className="muted">
        Comments made directly on websites with the Inklayer extension. Open a page to see its comments there.
      </p>
      <ErrorText error={pages.error} />
      {pages.data?.length === 0 && (
        <div className="empty">
          <p>No comments on live pages yet.</p>
          <p className="muted">On any website, click the Inklayer toolbar button and choose "Comment on this page".</p>
        </div>
      )}
      {pages.data && pages.data.length > 0 && (
        <table className="table">
          <thead><tr><th>Page</th><th>Open</th><th>Resolved</th><th>Last activity</th></tr></thead>
          <tbody>
            {pages.data.map((p) => (
              <tr key={p.pageUrl}>
                <td className="ellipsis"><a href={p.pageUrl} target="_blank" rel="noopener noreferrer">{p.pageUrl}</a></td>
                <td>{p.openCount}</td>
                <td>{p.resolvedCount}</td>
                <td className="muted">{timeAgo(p.lastActivityAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Settings({ project, onSaved }: { project: Project; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(project.name);
  const [matchQuery, setMatchQuery] = useState(project.liveMatchQuery);
  const [matchHash, setMatchHash] = useState(project.liveMatchHash);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await patch(`/api/projects/${project.id}`, {
        name,
        liveMatchQuery: matchQuery,
        liveMatchHash: matchHash,
      });
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(err as Error);
    }
  };

  return (
    <form className="stack narrow" onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></label>
      <h2>Live comments</h2>
      <p className="muted small">Which addresses count as the same page when people comment on live websites.</p>
      <label><input type="checkbox" checked={matchQuery} onChange={(e) => setMatchQuery(e.target.checked)} /> The query string makes a different page (e.g. <code>?id=42</code>)</label>
      <label><input type="checkbox" checked={matchHash} onChange={(e) => setMatchHash(e.target.checked)} /> The #hash makes a different page (apps that route with <code>#/path</code>)</label>
      <p className="muted small">
        When these are off, <code>/pricing?ref=email#faq</code> and <code>/pricing</code> are the same page. Only the parts that make a different page are stored,
        so leave them off if your URLs can carry secrets such as reset tokens. Turning one off later merges pages that now count as the same.
      </p>
      <div><button className="primary" type="submit">Save</button> {saved && <span className="ok">Saved.</span>}</div>
      <ErrorText error={error} />
    </form>
  );
}
