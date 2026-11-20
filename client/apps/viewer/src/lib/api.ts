import { createApi, type Role } from "@inklayer/api";

/**
 * Same-origin API client, typed from the server's OpenAPI document (see @inklayer/api). The session cookie
 * authenticates; every request carries the CSRF header the server requires for writes.
 */
export const api = createApi({
  baseUrl: globalThis.location?.origin ?? "",
  credentials: "same-origin",
  headers: { "X-Inklayer-Csrf": "1" },
});

export type {
  AdminUserResponse as AdminUser,
  FeaturesResponse as Features,
  InvitationResponse as Invitation,
  LivePageSummaryResponse as LivePageSummary,
  MemberResponse as Member,
  MeResponse as Me,
  NetworkAccessResponse as NetworkAccess,
  OrganizationResponse as Organization,
  ProjectResponse as Project,
  Role,
} from "@inklayer/api";
export { ApiError } from "@inklayer/api";

/** People in the organisation whose name starts with or contains `q`, for @mentions. */
export const lookupPeople = (orgId: string, q: string) =>
  api.get("/api/orgs/{orgId}/members/lookup", { params: { path: { orgId }, query: { q } } });

export const ROLES: Role[] = ["Viewer", "Commenter", "Editor", "Admin", "Owner"];
export const atLeast = (role: Role, minimum: Role) => ROLES.indexOf(role) >= ROLES.indexOf(minimum);
