import type { ReactNode } from "react";
import { useMe } from "../App";
import { post } from "../lib/api";
import { Link } from "../lib/router";

export function Layout({ children }: { children: ReactNode }) {
  const { me } = useMe();
  const signOut = async () => {
    await post("/auth/logout");
    window.location.href = "/";
  };
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">Inklayer</Link>
        <nav>
          {me.isSystemAdmin && <Link to="/admin">Admin</Link>}
          <span className="user" title={me.email}>
            {me.avatarUrl && <img src={me.avatarUrl} alt="" referrerPolicy="no-referrer" />}
            {me.displayName}
          </span>
          <button className="link" onClick={signOut}>Sign out</button>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}

export function ErrorText({ error }: { error: Error | null | undefined }) {
  return error ? <p className="error">{error.message}</p> : null;
}
