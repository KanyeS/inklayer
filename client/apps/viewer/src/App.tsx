import { createContext, useContext } from "react";
import { ApiError, get, type Me } from "./lib/api";
import { match, usePath } from "./lib/router";
import { useAsync } from "./lib/useAsync";
import { Layout } from "./components/Layout";
import { AdminPage } from "./pages/AdminPage";
import { HomePage } from "./pages/HomePage";
import { OrganizationPage } from "./pages/OrganizationPage";
import { ProjectPage } from "./pages/ProjectPage";
import { SignInPage } from "./pages/SignInPage";
import { SnapshotPage } from "./pages/SnapshotPage";

const MeContext = createContext<{ me: Me; reloadMe: () => Promise<void> } | null>(null);

export function useMe() {
  const value = useContext(MeContext);
  if (!value) throw new Error("useMe outside a signed-in page");
  return value;
}

export function App() {
  const path = usePath();
  const { data: me, error, loading, reload } = useAsync(() => get<Me>("/api/me"), []);

  if (loading && !me) return <div className="center muted">Loading…</div>;
  if (error instanceof ApiError && error.status === 401) return <SignInPage />;
  if (error || !me) return <div className="center error">Couldn't reach the server: {error?.message}</div>;

  let page: React.ReactNode = <NotFound />;
  let params: Record<string, string> | null;
  if (path === "/" || path === "") page = <HomePage />;
  else if (path === "/admin") page = <AdminPage />;
  else if ((params = match("/orgs/:orgId", path))) page = <OrganizationPage orgId={params.orgId!} />;
  else if ((params = match("/projects/:projectId", path))) page = <ProjectPage projectId={params.projectId!} />;
  else if ((params = match("/snapshots/:snapshotId", path))) page = <SnapshotPage snapshotId={params.snapshotId!} />;

  const fullBleed = path.startsWith("/snapshots/");
  return (
    <MeContext.Provider value={{ me, reloadMe: reload }}>
      <Layout fullBleed={fullBleed}>{page}</Layout>
    </MeContext.Provider>
  );
}

function NotFound() {
  return <div className="page"><h1>Not found</h1><p className="muted">That page doesn't exist.</p></div>;
}
