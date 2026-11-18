import { useMe } from "../App";
import { Link } from "../lib/router";

export function HomePage() {
  const { me } = useMe();
  return (
    <div className="page">
      <h1>Organisations</h1>
      {me.organizations.length === 0 ? (
        <div className="empty">
          <p>You're not a member of any organisation yet.</p>
          <p className="muted">{me.isSystemAdmin ? <>Create one on the <Link to="/admin">Admin</Link> page.</> : "Ask an administrator to invite you."}</p>
        </div>
      ) : (
        <ul className="cards">
          {me.organizations.map((org) => (
            <li key={org.id}>
              <Link to={`/orgs/${org.id}`} className="card link-card">
                <strong>{org.name}</strong>
                <span className="pill">{org.role}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
