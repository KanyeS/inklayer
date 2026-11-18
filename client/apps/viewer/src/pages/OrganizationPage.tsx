import { useState, type FormEvent } from "react";
import { useMe } from "../App";
import { ErrorText } from "../components/Layout";
import { ROLES, atLeast, del, get, patch, post, put, type Invitation, type Member, type Organization, type Project, type Role } from "../lib/api";
import { dateTime } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { useAsync } from "../lib/useAsync";

export function OrganizationPage({ orgId }: { orgId: string }) {
  const org = useAsync(() => get<Organization>(`/api/orgs/${orgId}`), [orgId]);
  const projects = useAsync(() => get<Project[]>(`/api/orgs/${orgId}/projects`), [orgId]);
  const [tab, setTab] = useState<"projects" | "members" | "settings">("projects");

  if (org.error) return <div className="page"><ErrorText error={org.error} /></div>;
  if (!org.data) return <div className="page muted">Loading…</div>;
  const isAdmin = atLeast(org.data.myRole, "Admin");

  return (
    <div className="page">
      <p className="crumbs"><Link to="/">Organisations</Link> /</p>
      <h1>{org.data.name} <span className="pill">{org.data.myRole}</span></h1>
      <div className="tabs">
        <button className={tab === "projects" ? "active" : ""} onClick={() => setTab("projects")}>Projects</button>
        <button className={tab === "members" ? "active" : ""} onClick={() => setTab("members")}>Members</button>
        {isAdmin && <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>}
      </div>

      {tab === "projects" && (
        <>
          {isAdmin && <CreateProject orgId={orgId} />}
          <ErrorText error={projects.error} />
          {projects.data?.length === 0 && <p className="empty">No projects yet.</p>}
          <ul className="cards">
            {projects.data?.map((p) => (
              <li key={p.id}>
                <Link to={`/projects/${p.id}`} className="card link-card"><strong>{p.name}</strong><span className="pill">{p.myRole}</span></Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {tab === "members" && <Members org={org.data} />}
      {tab === "settings" && isAdmin && <Settings org={org.data} onSaved={org.reload} />}
    </div>
  );
}

function CreateProject({ orgId }: { orgId: string }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const project = await post<Project>(`/api/orgs/${orgId}/projects`, { name });
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err as Error);
    }
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <input placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
      <button className="primary" type="submit">Create project</button>
      <ErrorText error={error} />
    </form>
  );
}

function Members({ org }: { org: Organization }) {
  const { me } = useMe();
  const isAdmin = atLeast(org.myRole, "Admin");
  const isOwner = org.myRole === "Owner";
  const members = useAsync(() => get<Member[]>(`/api/orgs/${org.id}/members`), [org.id]);
  const invitations = useAsync(() => (isAdmin ? get<Invitation[]>(`/api/orgs/${org.id}/invitations`) : Promise.resolve([])), [org.id, isAdmin]);
  const [error, setError] = useState<Error | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("Commenter");

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await Promise.all([members.reload(), invitations.reload()]);
    } catch (e) {
      setError(e as Error);
    }
  };
  const assignable = ROLES.filter((r) => isOwner || r !== "Owner");

  return (
    <>
      <ErrorText error={error ?? members.error} />
      {isAdmin && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act(async () => { await post(`/api/orgs/${org.id}/invitations`, { email, role }); setEmail(""); }); }}>
          <input type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>{assignable.map((r) => <option key={r}>{r}</option>)}</select>
          <button className="primary" type="submit">Invite</button>
          <span className="muted small">They join when they next sign in with this address.</span>
        </form>
      )}
      <table className="table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead>
        <tbody>
          {members.data?.map((m) => (
            <tr key={m.userId}>
              <td>{m.displayName}</td>
              <td className="muted">{m.email}</td>
              <td>
                {isAdmin && (isOwner || m.role !== "Owner") ? (
                  <select value={m.role} onChange={(e) => void act(() => put(`/api/orgs/${org.id}/members/${m.userId}`, { role: e.target.value }))}>
                    {assignable.map((r) => <option key={r}>{r}</option>)}
                  </select>
                ) : m.role}
              </td>
              <td className="right">
                {(m.userId === me.id || (isAdmin && (isOwner || m.role !== "Owner"))) && (
                  <button className="link danger" onClick={() => {
                    if (confirm(m.userId === me.id ? "Leave this organisation?" : `Remove ${m.displayName}?`)) {
                      void act(() => del(`/api/orgs/${org.id}/members/${m.userId}`)).then(() => { if (m.userId === me.id) window.location.href = "/"; });
                    }
                  }}>{m.userId === me.id ? "Leave" : "Remove"}</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {isAdmin && invitations.data && invitations.data.length > 0 && (
        <>
          <h2>Pending invitations</h2>
          <table className="table">
            <tbody>
              {invitations.data.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td><td>{i.role}</td><td className="muted">expires {dateTime(i.expiresAt)}</td>
                  <td className="right"><button className="link danger" onClick={() => void act(() => del(`/api/orgs/${org.id}/invitations/${i.id}`))}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function Settings({ org, onSaved }: { org: Organization; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(org.name);
  const [domains, setDomains] = useState(org.allowedDomains.join(", "));
  const [defaultRole, setDefaultRole] = useState<Role>(org.defaultRole);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await patch(`/api/orgs/${org.id}`, { name, defaultRole, allowedDomains: domains.split(/[\s,]+/).filter(Boolean) });
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(err as Error);
    }
  };
  return (
    <form className="stack narrow" onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></label>
      <label>
        Email domains that join automatically (Google Workspace, or a domain your SSO provider is verified for)
        <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="acme.com, acme.co.uk" />
      </label>
      <label>
        Role for people who join through a domain
        <select value={defaultRole} onChange={(e) => setDefaultRole(e.target.value as Role)}>
          {(["Viewer", "Commenter", "Editor"] as Role[]).map((r) => <option key={r}>{r}</option>)}
        </select>
      </label>
      <div><button className="primary" type="submit">Save</button> {saved && <span className="ok">Saved.</span>}</div>
      <ErrorText error={error} />
    </form>
  );
}
