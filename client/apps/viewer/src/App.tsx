import { Suspense, createContext, lazy, useContext } from "react";
import { ApiError, get, type Me } from "./lib/api";
import { match, usePath } from "./lib/router";
import { useAsync } from "./lib/useAsync";
import { Layout, Loading, Page, PageTitle } from "./components/Layout";
import { AdminPage } from "./pages/AdminPage";
import { CommentPage } from "./pages/CommentPage";
import { SettingsPage } from "./pages/SettingsPage";
import { HomePage } from "./pages/HomePage";
import { OrganizationPage } from "./pages/OrganizationPage";
import { PagesPage } from "./pages/PagesPage";
import { ProjectPage } from "./pages/ProjectPage";
import { SignInPage } from "./pages/SignInPage";

// The docs app (editor, live editing, graph) loads only when someone opens docs.
const DocsPage = lazy(() => import("./docs/DocsPage").then((m) => ({ default: m.DocsPage })));
const GraphPage = lazy(() => import("./docs/GraphPage").then((m) => ({ default: m.GraphPage })));
// Share links: for guests, with nothing of the signed-in app.
const SharePage = lazy(() => import("./pages/SharePage").then((m) => ({ default: m.SharePage })));

const MeContext = createContext<{ me: Me; reloadMe: () => Promise<void> } | null>(null);

export function useMe() {
  const value = useContext(MeContext);
  if (!value) throw new Error("useMe outside a signed-in page");
  return value;
}

export function App() {
  const path = usePath();
  const share = match("/s/:token", path);
  if (share) return <Suspense fallback={null}><SharePage token={share.token!} /></Suspense>;
  return <SignedInApp path={path} />;
}

function SignedInApp({ path }: { path: string }) {
  const { data: me, error, loading, reload } = useAsync(() => get<Me>("/api/me"), []);

  if (loading && !me) return <div className="grid min-h-svh place-items-center"><Loading /></div>;
  if (error instanceof ApiError && error.status === 401) return <SignInPage />;
  if (error || !me) return <div className="grid min-h-svh place-items-center p-6 text-destructive">Couldn't reach the server: {error?.message}</div>;

  let page: React.ReactNode = <NotFound />;
  let params: Record<string, string> | null;
  if (path === "/" || path === "") page = <HomePage />;
  else if (path === "/admin") page = <AdminPage />;
  else if (path === "/settings") page = <SettingsPage />;
  else if (path === "/pages") page = <PagesPage />;
  else if ((params = match("/orgs/:orgId", path))) page = <OrganizationPage orgId={params.orgId!} />;
  else if ((params = match("/orgs/:orgId/docs", path) ?? match("/orgs/:orgId/graph", path) ?? match("/orgs/:orgId/docs/:docId", path)) && !me.features.docs) {
    page = <TurnedOff what="Docs are" />;
  } else if ((params = match("/orgs/:orgId/docs", path))) page = <DocsPage orgId={params.orgId!} />;
  else if ((params = match("/orgs/:orgId/graph", path))) page = <GraphPage orgId={params.orgId!} />;
  else if ((params = match("/orgs/:orgId/docs/:docId", path))) page = <DocsPage key={params.orgId} orgId={params.orgId!} docId={params.docId!} />;
  else if ((params = match("/comments/:commentId", path))) page = <CommentPage commentId={params.commentId!} />;
  else if ((params = match("/projects/:projectId", path))) page = <ProjectPage projectId={params.projectId!} />;

  return (
    <MeContext.Provider value={{ me, reloadMe: reload }}>
      <Layout wide={path.startsWith("/orgs/") && /\/(docs|graph)(\/|$)/.test(path)}>
        <Suspense fallback={<Loading />}>{page}</Suspense>
      </Layout>
    </MeContext.Provider>
  );
}

function TurnedOff({ what }: { what: string }) {
  return <Page><PageTitle>{what} turned off</PageTitle><p className="text-muted-foreground">An administrator has turned this off on this server.</p></Page>;
}

function NotFound() {
  return <Page><PageTitle>Not found</PageTitle><p className="text-muted-foreground">That page doesn't exist.</p></Page>;
}
