import type { DocGraphResponse, DocResponse, DocSummaryResponse, DocTagCountResponse } from "@inklayer/api";
import { api } from "@/lib/api";

export type {
  AnnotationDetailResponse as CommentInfo,
  DocActor,
  DocCommentLinkResponse as DocCommentLink,
  DocGraphResponse as DocGraph,
  DocLinkResponse as DocLinkInfo,
  DocResponse as DocInfo,
  DocRevisionResponse as DocRevision,
  DocSearchResultResponse as DocSearchResult,
  DocSummaryResponse as DocSummary,
  DocTagCountResponse as DocTagInfo,
  DocTreeResponse as DocTree,
} from "@inklayer/api";

/** How a doc or tag looks in the graph and lists: a Lucide icon name and a #rrggbb colour, either null for the default. */
export type DocAppearance = Pick<DocSummaryResponse, "icon" | "color">;
export type DocGraphNode = DocGraphResponse["nodes"][number];

const org = (orgId: string) => ({ params: { path: { orgId } } });
const doc = (docId: string) => ({ params: { path: { docId } } });

export const docsApi = {
  tree: (orgId: string) => api.get("/api/orgs/{orgId}/docs", org(orgId)),
  create: (orgId: string, title: string, folder = "") =>
    api.post("/api/orgs/{orgId}/docs", { ...org(orgId), body: { title, folder } }),
  createFolder: (orgId: string, path: string) =>
    api.post("/api/orgs/{orgId}/docs/folders", { ...org(orgId), body: { path } }),
  moveFolder: (orgId: string, from: string, to: string) =>
    api.patch("/api/orgs/{orgId}/docs/folders", { ...org(orgId), body: { from, to } }),
  deleteFolder: (orgId: string, path: string) =>
    api.delete("/api/orgs/{orgId}/docs/folders", { params: { path: { orgId }, query: { path } } }),
  search: (orgId: string, q: string) =>
    api.get("/api/orgs/{orgId}/docs/search", { params: { path: { orgId }, query: { q } } }),
  tags: (orgId: string) => api.get("/api/orgs/{orgId}/docs/tags", org(orgId)),
  /** Sets a tag's icon and colour for the whole organisation (both null for the defaults). */
  setTagStyle: (orgId: string, tag: string, appearance: { icon: string | null; color: string | null }) =>
    api.put("/api/orgs/{orgId}/docs/tags/{tag}", {
      params: { path: { orgId, tag } },
      body: appearance,
    }) as Promise<DocTagCountResponse>,
  graph: (orgId: string) => api.get("/api/orgs/{orgId}/docs/graph", org(orgId)),
  doc: (docId: string) => api.get("/api/docs/{docId}", doc(docId)),
  update: (docId: string, body: { version: number; title?: string; folder?: string }) =>
    api.patch("/api/docs/{docId}", { ...doc(docId), body }),
  delete: (docId: string, version: number) =>
    api.delete("/api/docs/{docId}", { params: { path: { docId }, query: { version } } }),
  /** Sets the doc's icon and colour (null for the defaults). Not a change to the doc: no version needed. */
  setAppearance: (docId: string, appearance: { icon: string | null; color: string | null }) =>
    api.put("/api/docs/{docId}/appearance", { ...doc(docId), body: appearance }) as Promise<DocResponse>,
  history: (docId: string) => api.get("/api/docs/{docId}/history", doc(docId)),
  revision: (docId: string, revisionId: string) =>
    api.get("/api/docs/{docId}/history/{revisionId}", { params: { path: { docId, revisionId } } }),
  comment: (id: string) => api.get("/api/annotations/{annotationId}", { params: { path: { annotationId: id } } }),
};

export { docPath } from "./paths";
