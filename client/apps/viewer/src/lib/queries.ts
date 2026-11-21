import { queryOptions } from "@tanstack/react-query";
import { docsApi } from "@/docs/docsApi";
import { api, type Role } from "./api";

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
  orgTeams: (orgId: string) =>
    queryOptions({
      queryKey: ["orgs", orgId, "teams"],
      queryFn: () => api.get("/api/orgs/{orgId}/teams", org(orgId)),
    }),
  teamMembers: (teamId: string) =>
    queryOptions({
      queryKey: ["teams", teamId, "members"],
      queryFn: () => api.get("/api/teams/{teamId}/members", { params: { path: { teamId } } }),
    }),
  /** Who has access to a product (`project`), feature or doc. */
  access: (resourceType: "project" | "feature" | "doc", resourceId: string) =>
    queryOptions({
      queryKey: ["access", resourceType, resourceId],
      queryFn: () =>
        api.get("/api/access/{resourceType}/{resourceId}", { params: { path: { resourceType, resourceId } } }),
    }),
  accessPeople: (resourceType: "project" | "feature" | "doc", resourceId: string) =>
    queryOptions({
      queryKey: ["access", resourceType, resourceId, "people"],
      queryFn: () =>
        api.get("/api/access/{resourceType}/{resourceId}/people", { params: { path: { resourceType, resourceId } } }),
    }),
  accessRequests: (resourceType: "project" | "feature" | "doc", resourceId: string) =>
    queryOptions({
      queryKey: ["access", resourceType, resourceId, "requests"],
      queryFn: () =>
        api.get("/api/access/{resourceType}/{resourceId}/requests", { params: { path: { resourceType, resourceId } } }),
    }),
  /** What a person (`user`) or team can reach and how; `preview` shows a change before it's made. */
  accessMap: (
    orgId: string,
    principalType: "user" | "team",
    principalId: string,
    preview?: { addProjectId: string; addRole: Role } | { addTeamId: string },
  ) =>
    queryOptions({
      queryKey: ["access", "map", orgId, principalType, principalId, preview ?? null],
      queryFn: () =>
        api.get("/api/orgs/{orgId}/access-map/{principalType}/{principalId}", {
          params: { path: { orgId, principalType, principalId }, query: preview ?? {} },
        }),
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
