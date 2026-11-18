import { del, get, patch, post } from "@/lib/api";

export interface DocActor {
  id: string;
  displayName: string;
  fullName?: string | null;
  role?: string | null;
}

export interface DocSummary {
  id: string;
  folder: string;
  title: string;
  updatedAt: string;
  tags: string[];
}

export interface DocTree {
  folders: string[];
  docs: DocSummary[];
  canEdit: boolean;
}

export interface DocLinkInfo {
  text: string;
  docId: string | null;
  title: string | null;
  folder: string | null;
}

export interface DocCommentLink {
  annotationId: string;
  projectId: string;
  projectName: string;
  pageUrl: string | null;
  body: string;
  status: "Open" | "Resolved";
  author: DocActor;
}

export interface DocInfo {
  id: string;
  organizationId: string;
  folder: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: DocActor | null;
  canEdit: boolean;
  tags: string[];
  backlinks: DocSummary[];
  commentBacklinks: DocCommentLink[];
  links: DocLinkInfo[];
  commentLinks: string[];
}

export interface DocRevision {
  id: string;
  version: number;
  action: string;
  actor: DocActor;
  occurredAt: string;
  folder: string;
  title: string;
}

export interface DocSearchResult {
  id: string;
  folder: string;
  title: string;
  /** Matched words are wrapped in \u0002 … \u0003. */
  snippet: string;
}

export interface DocGraph {
  nodes: { id: string; kind: "doc" | "comment"; label: string; docId: string | null; annotationId: string | null; folder: string | null }[];
  edges: { source: string; target: string }[];
}

/** A page comment, for links from docs. */
export interface CommentInfo {
  id: string;
  organizationId: string;
  projectId: string;
  projectName: string;
  pageUrl: string | null;
  body: string;
  status: "Open" | "Resolved";
  author: DocActor;
  createdAt: string;
  mentionedIn: { docId: string; title: string }[];
}

export const docsApi = {
  tree: (orgId: string) => get<DocTree>(`/api/orgs/${orgId}/docs`),
  create: (orgId: string, title: string, folder = "") => post<DocSummary>(`/api/orgs/${orgId}/docs`, { title, folder }),
  createFolder: (orgId: string, path: string) => post<{ path: string }>(`/api/orgs/${orgId}/docs/folders`, { path }),
  moveFolder: (orgId: string, from: string, to: string) => patch<{ relinkDocs: string[] }>(`/api/orgs/${orgId}/docs/folders`, { from, to }),
  deleteFolder: (orgId: string, path: string) => del(`/api/orgs/${orgId}/docs/folders?path=${encodeURIComponent(path)}`),
  search: (orgId: string, q: string) => get<DocSearchResult[]>(`/api/orgs/${orgId}/docs/search?q=${encodeURIComponent(q)}`),
  tags: (orgId: string) => get<{ tag: string; count: number }[]>(`/api/orgs/${orgId}/docs/tags`),
  graph: (orgId: string) => get<DocGraph>(`/api/orgs/${orgId}/docs/graph`),
  doc: (docId: string) => get<DocInfo>(`/api/docs/${docId}`),
  update: (docId: string, body: { version: number; title?: string; folder?: string }) =>
    patch<{ doc: DocInfo; relinkDocs: string[] }>(`/api/docs/${docId}`, body),
  delete: (docId: string, version: number) => del(`/api/docs/${docId}?version=${version}`),
  history: (docId: string) => get<DocRevision[]>(`/api/docs/${docId}/history`),
  revision: (docId: string, revisionId: string) => get<DocRevision & { content: string }>(`/api/docs/${docId}/history/${revisionId}`),
  comment: (id: string) => get<CommentInfo>(`/api/annotations/${id}`),
};

export const docPath = (orgId: string, docId: string) => `/orgs/${orgId}/docs/${docId}`;
