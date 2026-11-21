import { queryOptions } from "@tanstack/react-query";
import { docsApi } from "@/docs/docsApi";
import { api } from "./api";

/**
 * Everything the viewer reads from the server, as TanStack Query options: one place for each query's key and request,
 * so components that show the same data share it. Keys start with what the data belongs to (an organisation, a
 * project, a doc), so related data can be refreshed together.
 */
const org = (orgId: string) => ({ params: { path: { orgId } } });
const project = (projectId: string) => ({ params: { path: { projectId } } });

export const queries = {
  me: () => queryOptions({ queryKey: ["me"], queryFn: () => api.get("/api/me") }),
  connectedApps: () => queryOptions({ queryKey: ["me", "apps"], queryFn: () => api.get("/api/me/apps") }),
  trackerAccounts: () =>
    queryOptions({ queryKey: ["me", "tracker-accounts"], queryFn: () => api.get("/api/me/tracker-accounts") }),
  livePages: () => queryOptions({ queryKey: ["live", "pages"], queryFn: () => api.get("/api/live/pages") }),

  org: (orgId: string) =>
    queryOptions({ queryKey: ["orgs", orgId], queryFn: () => api.get("/api/orgs/{orgId}", org(orgId)) }),
  orgProjects: (orgId: string) =>
    queryOptions({
      queryKey: ["orgs", orgId, "projects"],
      queryFn: () => api.get("/api/orgs/{orgId}/projects", org(orgId)),
    }),
  orgMembers: (orgId: string) =>
    queryOptions({
      queryKey: ["orgs", orgId, "members"],
      queryFn: () => api.get("/api/orgs/{orgId}/members", org(orgId)),
    }),
  orgInvitations: (orgId: string) =>
    queryOptions({
      queryKey: ["orgs", orgId, "invitations"],
      queryFn: () => api.get("/api/orgs/{orgId}/invitations", org(orgId)),
    }),
  orgIntegrations: (orgId: string) =>
    queryOptions({
      queryKey: ["orgs", orgId, "integrations"],
      queryFn: () => api.get("/api/orgs/{orgId}/integrations", org(orgId)),
    }),

  project: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId],
      queryFn: () => api.get("/api/projects/{projectId}", project(projectId)),
    }),
  projectPages: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "pages"],
      queryFn: () => api.get("/api/projects/{projectId}/live/pages", project(projectId)),
    }),
  projectShares: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "shares"],
      queryFn: () => api.get("/api/shares", { params: { query: { projectId } } }),
    }),
  issueTrackers: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "issue-trackers"],
      queryFn: () => api.get("/api/projects/{projectId}/issue-trackers", project(projectId)),
    }),
  issueTrackerChoices: (projectId: string) =>
    queryOptions({
      queryKey: ["projects", projectId, "issue-trackers", "choices"],
      queryFn: () => api.get("/api/projects/{projectId}/issue-trackers/choices", project(projectId)),
    }),

  comment: (commentId: string) =>
    queryOptions({
      queryKey: ["comments", commentId],
      queryFn: () => api.get("/api/annotations/{annotationId}", { params: { path: { annotationId: commentId } } }),
    }),
  publicShare: (token: string) =>
    queryOptions({
      queryKey: ["public-shares", token],
      queryFn: () => api.get("/api/public/shares/{token}", { params: { path: { token } } }),
    }),

  docTree: (orgId: string) => queryOptions({ queryKey: ["orgs", orgId, "docs"], queryFn: () => docsApi.tree(orgId) }),
  docGraph: (orgId: string) =>
    queryOptions({ queryKey: ["orgs", orgId, "docs", "graph"], queryFn: () => docsApi.graph(orgId) }),
  doc: (docId: string) => queryOptions({ queryKey: ["docs", docId], queryFn: () => docsApi.doc(docId) }),
  docHistory: (docId: string) =>
    queryOptions({ queryKey: ["docs", docId, "history"], queryFn: () => docsApi.history(docId) }),
  docShares: (docId: string) =>
    queryOptions({
      queryKey: ["docs", docId, "shares"],
      queryFn: () => api.get("/api/shares", { params: { query: { docId } } }),
    }),

  admin: {
    users: () => queryOptions({ queryKey: ["admin", "users"], queryFn: () => api.get("/api/admin/users") }),
    shares: () => queryOptions({ queryKey: ["admin", "shares"], queryFn: () => api.get("/api/admin/shares") }),
    network: () => queryOptions({ queryKey: ["admin", "network"], queryFn: () => api.get("/api/admin/network") }),
    features: () => queryOptions({ queryKey: ["admin", "features"], queryFn: () => api.get("/api/admin/features") }),
    email: () => queryOptions({ queryKey: ["admin", "email"], queryFn: () => api.get("/api/admin/email") }),
  },
};
