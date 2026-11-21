import { Button } from "@inklayer/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@inklayer/ui/components/field";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { Textarea } from "@inklayer/ui/components/textarea";
import { type FormEvent, useState } from "react";
import { ErrorText } from "@/components/Layout";
import { api, GRANT_ROLES, type Project, type Role } from "@/lib/api";
import { useAction } from "@/lib/query";
import { ROLE_HELP } from "./RoleGuide";

/**
 * Shown instead of a product's contents to members who can't open it: ask for access. The product's Managers and the
 * organisation's Admins are notified, and the person hears back when someone answers.
 */
export function RequestAccess({ project }: { project: Project }) {
  const [role, setRole] = useState<Role>("Viewer");
  const [message, setMessage] = useState("");
  const { run, error } = useAction();
  const path = { resourceType: "project", resourceId: project.id };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await run(() =>
      api.post("/api/access/{resourceType}/{resourceId}/requests", { params: { path }, body: { role, message } }),
    );
  };

  if (project.accessRequested)
    return (
      <div className="max-w-md space-y-2 rounded-md border p-4">
        <p className="font-medium">Access requested</p>
        <p className="text-sm text-muted-foreground">
          The product's managers have been told. You'll get a notification when someone answers.
        </p>
      </div>
    );

  return (
    <form className="max-w-md space-y-4 rounded-md border p-4" onSubmit={submit}>
      <div>
        <p className="font-medium">You don't have access to {project.name} yet</p>
        <p className="text-sm text-muted-foreground">
          Ask, and its managers and your organisation's admins will be told.
        </p>
      </div>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="request-role">Access you need</FieldLabel>
          <NativeSelect id="request-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {GRANT_ROLES.map((r) => (
              <NativeSelectOption key={r} value={r}>
                {r}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>{ROLE_HELP[role]}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="request-message">Why (optional)</FieldLabel>
          <Textarea
            id="request-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={1000}
            placeholder="e.g. I'm picking up checkout bugs from support"
          />
        </Field>
        <div>
          <Button type="submit">Request access</Button>
        </div>
        <ErrorText error={error} />
      </FieldGroup>
    </form>
  );
}
