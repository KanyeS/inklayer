import { del, get, patch, post, put } from "@/lib/api";

export interface DocActor {
  id: string;
  displayName: string;
  fullName?: string | null;
  role?: string | null;
}

/** How a doc looks in the graph and lists: a Lucide icon name and a #rrggbb colour, either null for the default. */
export interface DocAppearance {
  icon?: string | null;
  color?: string | null;
}

export interface DocSummary extends DocAppearance {
  id: string;
  folder: string;
  title: string;
  updatedAt: string;
  tags: string[];
}

/** A #tag in use, with how many docs have it and its icon and colour (set for the whole organisation). */
export interface DocTagInfo extends DocAppearance {
  tag: string;
  count: number;
}

export interface DocTree {
  folders: string[];
  docs: DocSummary[];
  canEdit: boolean;
  tags?: DocTagInfo[];
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

export interface DocInfo extends DocAppearance {
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
  /** People @mentioned in the doc. */
  people?: { id: string; displayName: string; fullName: string }[];
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
  nodes: ({
    id: string;
    kind: "doc" | "comment";
    label: string;
    docId: string | null;
    annotationId: string | null;
    folder: string | null;
  } & DocAppearance)[];
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
  moveFolder: (orgId: string, from: string, to: string) =>
    patch<{ relinkDocs: string[] }>(`/api/orgs/${orgId}/docs/folders`, { from, to }),
  deleteFolder: (orgId: string, path: string) =>
    del(`/api/orgs/${orgId}/docs/folders?path=${encodeURIComponent(path)}`),
  search: (orgId: string, q: string) =>
    get<DocSearchResult[]>(`/api/orgs/${orgId}/docs/search?q=${encodeURIComponent(q)}`),
  tags: (orgId: string) => get<DocTagInfo[]>(`/api/orgs/${orgId}/docs/tags`),
  /** Sets a tag's icon and colour for the whole organisation (both null for the defaults). */
  setTagStyle: (orgId: string, tag: string, appearance: { icon: string | null; color: string | null }) =>
    put<DocTagInfo>(`/api/orgs/${orgId}/docs/tags/${encodeURIComponent(tag)}`, appearance),
  graph: (orgId: string) => get<DocGraph>(`/api/orgs/${orgId}/docs/graph`),
  doc: (docId: string) => get<DocInfo>(`/api/docs/${docId}`),
  update: (docId: string, body: { version: number; title?: string; folder?: string }) =>
    patch<{ doc: DocInfo; relinkDocs: string[] }>(`/api/docs/${docId}`, body),
  delete: (docId: string, version: number) => del(`/api/docs/${docId}?version=${version}`),
  /** Sets the doc's icon and colour (null for the defaults). Not a change to the doc: no version needed. */
  setAppearance: (docId: string, appearance: { icon: string | null; color: string | null }) =>
    put<DocInfo>(`/api/docs/${docId}/appearance`, appearance),
  history: (docId: string) => get<DocRevision[]>(`/api/docs/${docId}/history`),
  revision: (docId: string, revisionId: string) =>
    get<DocRevision & { content: string }>(`/api/docs/${docId}/history/${revisionId}`),
  comment: (id: string) => get<CommentInfo>(`/api/annotations/${id}`),
};

export { docPath } from "./paths";
