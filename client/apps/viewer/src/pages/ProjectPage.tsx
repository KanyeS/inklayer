import { useState, type FormEvent } from "react";
import { ErrorText } from "../components/Layout";
import { atLeast, get, patch, type LivePageSummary, type Project } from "../lib/api";
import { timeAgo } from "../lib/format";
import { Link } from "../lib/router";
import { useAsync } from "../lib/useAsync";

type Tab = "pages" | "settings";

export function ProjectPage({ projectId }: { projectId: string }) {
  const project = useAsync(() => get<Project>(`/api/projects/${projectId}`), [projectId]);
  const [tab, setTab] = useState<Tab>("pages");

  if (project.error) return <div className="page"><ErrorText error={project.error} /></div>;
  if (!project.data) return <div className="page muted">Loading…</div>;
  const isAdmin = atLeast(project.data.myRole, "Admin");

  return (
    <div className="page">
      <p className="crumbs"><Link to={`/orgs/${project.data.organizationId}`}>Organisation</Link> /</p>
      <h1>{project.data.name} <span className="pill">{project.data.myRole}</span></h1>
      <div className="tabs">
        <button className={tab === "pages" ? "active" : ""} onClick={() => setTab("pages")}>Pages</button>
        {isAdmin && <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>}
      </div>
      {tab === "pages" && <Pages project={project.data} />}
      {tab === "settings" && isAdmin && <Settings project={project.data} onSaved={project.reload} />}
    </div>
  );
}

/** Pages with comments in this project. Opening one shows the comments on the page itself, through the extension. */
function Pages({ project }: { project: Project }) {
  const pages = useAsync(() => get<LivePageSummary[]>(`/api/projects/${project.id}/live/pages`), [project.id]);

  return (
    <>
      <p className="muted">
        Pages people have commented on with the Inklayer extension. Open one to see its comments on the page.
      </p>
      <ErrorText error={pages.error} />
      {pages.data?.length === 0 && (
        <div className="empty">
          <p>No comments yet.</p>
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
      <h2>Page addresses</h2>
      <p className="muted small">Which addresses count as the same page when people comment.</p>
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
