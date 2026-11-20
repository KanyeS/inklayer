import { Button } from "@inklayer/ui/components/button";
import { Checkbox } from "@inklayer/ui/components/checkbox";
import { Field, FieldDescription, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { type FormEvent, useState } from "react";
import { useMe } from "@/App";
import { ErrorText, Page, PageTitle, SectionTitle } from "@/components/Layout";
import { api } from "@/lib/api";
import { useAction } from "@/lib/query";

/** Your own settings: the name others see. */
export function SettingsPage() {
  const { me } = useMe();
  const [name, setName] = useState(me.preferredName ?? "");
  const [saved, setSaved] = useState(false);
  const { run, error } = useAction();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const done = await run(() => api.patch("/api/me", { body: { preferredName: name } }));
    setSaved(done.ok);
  };

  return (
    <Page className="max-w-2xl">
      <PageTitle>Settings</PageTitle>
      <SectionTitle>Your name</SectionTitle>
      <form className="flex max-w-md flex-col gap-3" onSubmit={save}>
        <Field>
          <FieldLabel htmlFor="preferred-name">Name shown to others</FieldLabel>
          <Input
            id="preferred-name"
            value={name}
            maxLength={80}
            placeholder={me.fullName}
            onChange={(e) => setName(e.target.value)}
          />
          <FieldDescription>
            Leave empty to use your name from sign-in, <strong>{me.fullName}</strong>. People can still see that name,
            and your role, when they hover over yours.
          </FieldDescription>
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit">Save</Button>
          {saved && <span className="text-sm text-muted-foreground">Saved.</span>}
        </div>
        <ErrorText error={error} />
      </form>

      <SectionTitle>Notifications</SectionTitle>
      <label className="flex max-w-md items-start gap-3 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={me.emailNotifications}
          onCheckedChange={(checked) =>
            void run(() => api.patch("/api/me", { body: { emailNotifications: checked === true } }))
          }
        />
        <span>
          Email me when I'm mentioned, when someone replies in a thread I'm in, and when my comment is resolved.
          <span className="block text-muted-foreground">
            Only if your organisation sends notifications by email. You always see them under the bell.
          </span>
        </span>
      </label>
    </Page>
  );
}
