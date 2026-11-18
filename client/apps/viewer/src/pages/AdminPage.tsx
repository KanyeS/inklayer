import { useState, type FormEvent } from "react";
import { useMe } from "../App";
import { ErrorText } from "../components/Layout";
import { get, post, type AdminUser, type Organization } from "../lib/api";
import { timeAgo } from "../lib/format";
import { navigate } from "../lib/router";
import { useAsync } from "../lib/useAsync";

export function AdminPage() {
  const { me, reloadMe } = useMe();
  const users = useAsync(() => get<AdminUser[]>("/api/admin/users"), []);
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [error, setError] = useState<Error | null>(null);

  if (!me.isSystemAdmin) return <div className="page"><p className="error">Instance administrators only.</p></div>;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const org = await post<Organization>("/api/orgs", { name, allowedDomains: domains.split(/[\s,]+/).filter(Boolean) });
      await reloadMe();
      navigate(`/orgs/${org.id}`);
    } catch (err) {
      setError(err as Error);
    }
  };
  const toggle = async (user: AdminUser) => {
    if (!user.isDisabled && !confirm(`Disable ${user.email}? They are signed out everywhere immediately.`)) return;
    try {
      await post(`/api/admin/users/${user.id}/${user.isDisabled ? "enable" : "disable"}`);
      await users.reload();
    } catch (err) {
      setError(err as Error);
    }
  };

  return (
    <div className="page">
      <h1>Administration</h1>
      <h2>New organisation</h2>
      <form className="stack narrow" onSubmit={create}>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></label>
        <label>Google Workspace domains that join automatically (optional)<input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="acme.com" /></label>
        <div><button className="primary" type="submit">Create organisation</button></div>
      </form>
      <ErrorText error={error ?? users.error} />
      <h2>Users</h2>
      <table className="table">
        <thead><tr><th>Name</th><th>Email</th><th>Last sign-in</th><th /></tr></thead>
        <tbody>
          {users.data?.map((u) => (
            <tr key={u.id} className={u.isDisabled ? "disabled" : ""}>
              <td>{u.displayName} {u.isSystemAdmin && <span className="pill">Admin</span>}</td>
              <td className="muted">{u.email}</td>
              <td className="muted">{timeAgo(u.lastSignInAt)}</td>
              <td className="right">{u.id !== me.id && <button className="link danger" onClick={() => void toggle(u)}>{u.isDisabled ? "Enable" : "Disable"}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
