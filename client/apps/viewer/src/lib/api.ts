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
  AccessPersonResponse as AccessPerson,
  AccessRequestResponse as AccessRequest,
  AccessResponse as Access,
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
  SignInProviderResponse as SignInProvider,
  TeamMemberResponse as TeamMember,
  TeamResponse as Team,
  TrackerAppResponse as TrackerApp,
} from "@inklayer/api";
export { ApiError } from "@inklayer/api";

/** People in the organisation whose name starts with or contains `q`, for @mentions. */
export const lookupPeople = (orgId: string, q: string) =>
  api.get("/api/orgs/{orgId}/members/lookup", { params: { path: { orgId }, query: { q } } });

/** Every role, lowest first. Manager is only given on a product, feature or doc. */
export const ROLES: Role[] = ["Viewer", "Commenter", "Editor", "Manager", "Admin", "Owner"];

/** Roles someone can have in the organisation itself. */
export const ORG_ROLES: Role[] = ROLES.filter((r) => r !== "Manager");

/** Roles that can be given to a person or team on a product, feature or doc. */
export const GRANT_ROLES: Role[] = ["Viewer", "Commenter", "Editor", "Manager"];
/** Whether `role` is `minimum` or higher. No role (no access) is never enough. */
export const atLeast = (role: Role | null | undefined, minimum: Role) =>
  role != null && ROLES.indexOf(role) >= ROLES.indexOf(minimum);
