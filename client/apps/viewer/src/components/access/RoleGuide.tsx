import type { Role } from "@/lib/api";

/** What each role can do, in one place. Shown wherever roles are chosen. */
export const ROLE_HELP: Record<Role, string> = {
  Viewer: "Reads comments and docs.",
  Commenter: "Also comments and replies.",
  Editor: "Also edits docs and triages comments.",
  Manager: "Also decides who has access, here and below.",
  Admin: "Manages the whole organisation: members, teams, products and settings.",
  Owner: "Also makes and removes other Owners.",
};

/** A short legend of the roles that can be given on a product, feature or doc, with the rule that ties them together. */
export function RoleGuide() {
  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="cursor-pointer font-medium">How access works</summary>
      <div className="mt-2 space-y-2 text-muted-foreground">
        <p>
          People only see products they've been given access to, directly or through a team. Access to a product covers
          everything in it. If someone gets more than one role, the highest applies. Organisation Admins and Owners
          reach everything.
        </p>
        <ul className="space-y-1">
          {(["Viewer", "Commenter", "Editor", "Manager"] as const).map((r) => (
            <li key={r}>
              <span className="font-medium text-foreground">{r}</span>: {ROLE_HELP[r]}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
