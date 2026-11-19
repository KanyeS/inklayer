import { createContext, lazy, type ReactNode, Suspense, useContext } from "react";
import { Layout, Loading, Page, PageTitle } from "./components/Layout";
import { ApiError, get, type Me } from "./lib/api";
import { findRoute, match, type Route, usePath } from "./lib/router";
import { useAsync } from "./lib/useAsync";
import { AdminPage } from "./pages/AdminPage";
import { CommentPage } from "./pages/CommentPage";
import { HomePage } from "./pages/HomePage";
import { OrganizationPage } from "./pages/OrganizationPage";
import { PagesPage } from "./pages/PagesPage";
import { ProjectPage } from "./pages/ProjectPage";
import { SettingsPage } from "./pages/SettingsPage";
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
  if (share)
    return (
      <Suspense fallback={null}>
        <SharePage token={share.token!} />
      </Suspense>
    );
  return <SignedInApp path={path} />;
}

function SignedInApp({ path }: { path: string }) {
  const { data: me, error, loading, reload } = useAsync(() => get<Me>("/api/me"), []);

  if (loading && !me)
    return (
      <div className="grid min-h-svh place-items-center">
        <Loading />
      </div>
    );
  if (error instanceof ApiError && error.status === 401) return <SignInPage />;
  if (error || !me)
    return (
      <div className="grid min-h-svh place-items-center p-6 text-destructive">
        Couldn't reach the server: {error?.message}
      </div>
    );

  return (
    <MeContext.Provider value={{ me, reloadMe: reload }}>
      <Layout wide={isWide(path)}>
        <Suspense fallback={<Loading />}>{pageFor(path, me)}</Suspense>
      </Layout>
    </MeContext.Provider>
  );
}

type Params = Record<string, string>;

/** Every signed-in page, by address. Docs pages are shown only while docs are turned on. */
function routes(me: Me): Route<(params: Params) => ReactNode>[] {
  const docsOn = () => me.features.docs;
  const param = (p: Params, name: string) => p[name] ?? "";
  return [
    { pattern: "/", page: () => <HomePage /> },
    { pattern: "/admin", page: () => <AdminPage /> },
    { pattern: "/settings", page: () => <SettingsPage /> },
    { pattern: "/pages", page: () => <PagesPage /> },
    { pattern: "/orgs/:orgId", page: (p) => <OrganizationPage orgId={param(p, "orgId")} /> },
    { pattern: "/orgs/:orgId/docs", enabled: docsOn, page: (p) => <DocsPage orgId={param(p, "orgId")} /> },
    { pattern: "/orgs/:orgId/graph", enabled: docsOn, page: (p) => <GraphPage orgId={param(p, "orgId")} /> },
    {
      pattern: "/orgs/:orgId/docs/:docId",
      enabled: docsOn,
      page: (p) => <DocsPage key={p.orgId} orgId={param(p, "orgId")} docId={param(p, "docId")} />,
    },
    { pattern: "/comments/:commentId", page: (p) => <CommentPage commentId={param(p, "commentId")} /> },
    { pattern: "/projects/:projectId", page: (p) => <ProjectPage projectId={param(p, "projectId")} /> },
  ];
}

function pageFor(path: string, me: Me): ReactNode {
  const found = findRoute(routes(me), path);
  if (!found) return <NotFound />;
  if (found.route.enabled && !found.route.enabled()) return <TurnedOff what="Docs are" />;
  return found.route.page(found.params);
}

/** Docs and the graph use the whole window; other pages sit in a centred column. */
function isWide(path: string): boolean {
  return path.startsWith("/orgs/") && /\/(docs|graph)(\/|$)/.test(path);
}

function TurnedOff({ what }: { what: string }) {
  return (
    <Page>
      <PageTitle>{what} turned off</PageTitle>
      <p className="text-muted-foreground">An administrator has turned this off on this server.</p>
    </Page>
  );
}

function NotFound() {
  return (
    <Page>
      <PageTitle>Not found</PageTitle>
      <p className="text-muted-foreground">That page doesn't exist.</p>
    </Page>
  );
}
