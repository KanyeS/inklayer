/** Same-origin API client. The session cookie authenticates; writes carry the CSRF header the server requires. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-Inklayer-Csrf", "1");
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const text = await response.text();
  const body: unknown = text ? tryJson(text) : null;
  if (!response.ok) {
    const problem = body as { title?: string; detail?: string; errors?: Record<string, string[]> } | null;
    const details = problem?.errors ? Object.values(problem.errors).flat().join(" ") : "";
    throw new ApiError(response.status, [problem?.detail ?? problem?.title ?? `Request failed (${response.status})`, details].filter(Boolean).join(" "), body);
  }
  return body as T;
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const put = <T,>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T,>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = (path: string) => api<null>(path, { method: "DELETE" });

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type Role = "Viewer" | "Commenter" | "Editor" | "Admin" | "Owner";
export const ROLES: Role[] = ["Viewer", "Commenter", "Editor", "Admin", "Owner"];
export const atLeast = (role: Role, minimum: Role) => ROLES.indexOf(role) >= ROLES.indexOf(minimum);

export interface Me {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  isSystemAdmin: boolean;
  organizations: { id: string; name: string; role: Role }[];
}

export interface Organization {
  id: string;
  name: string;
  defaultRole: Role;
  allowedDomains: string[];
  myRole: Role;
}

export interface Member {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: Role;
  joinedAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  isArchived: boolean;
  myRole: Role;
  /** Live comments: whether the query string / #hash make a different page. */
  liveMatchQuery: boolean;
  liveMatchHash: boolean;
}

export interface LivePageSummary {
  pageUrl: string;
  openCount: number;
  resolvedCount: number;
  lastActivityAt: string;
}

export interface SnapshotSummary {
  id: string;
  url: string;
  title: string;
  capturedAt: string;
  capturedBy: { id: string; displayName: string };
  hasScreenshot: boolean;
  assetCount: number;
}

export interface Snapshot extends SnapshotSummary {
  projectId: string;
  organizationId: string;
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  viewUrl: string | null;
  screenshotUrl: string | null;
}

export interface Annotation {
  id: string;
  /** Set for snapshot annotations; live-page annotations have pageUrl instead. */
  snapshotId: string | null;
  pageUrl: string | null;
  kind: import("@inklayer/overlay").AnnotationKind;
  status: "Open" | "Resolved";
  body: string;
  color: string;
  anchor: import("@inklayer/overlay").Anchor;
  geometry: import("@inklayer/overlay").Geometry;
  viewportWidth: number;
  version: number;
  author: { id: string; displayName: string; avatarUrl: string | null };
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canDelete: boolean;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  isSystemAdmin: boolean;
  isDisabled: boolean;
  lastSignInAt: string;
}
