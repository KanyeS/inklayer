import { useState, type FormEvent } from "react";
import { useMe } from "@/App";
import { ErrorText, Page, PageTitle, SectionTitle } from "@/components/Layout";
import { Button } from "@inklayer/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { Checkbox } from "@inklayer/ui/components/checkbox";
import { patch, type Me } from "@/lib/api";

/** Your own settings: the name others see. */
export function SettingsPage() {
  const { me, reloadMe } = useMe();
  const [name, setName] = useState(me.preferredName ?? "");
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    try {
      await patch<Me>("/api/me", { preferredName: name });
      setError(null);
      setSaved(true);
      await reloadMe();
    } catch (err) {
      setError(err as Error);
    }
  };

  return (
    <Page className="max-w-2xl">
      <PageTitle>Settings</PageTitle>
      <SectionTitle>Your name</SectionTitle>
      <form className="flex max-w-md flex-col gap-3" onSubmit={save}>
        <Field>
          <FieldLabel htmlFor="preferred-name">Name shown to others</FieldLabel>
          <Input id="preferred-name" value={name} maxLength={80} placeholder={me.fullName} onChange={(e) => setName(e.target.value)} />
          <FieldDescription>
            Leave empty to use your name from sign-in, <strong>{me.fullName}</strong>. People can still see that name, and your role, when they hover over yours.
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
        <Checkbox className="mt-0.5" checked={me.emailNotifications} onCheckedChange={async (checked) => {
          await patch<Me>("/api/me", { emailNotifications: checked === true });
          await reloadMe();
        }} />
        <span>
          Email me when I'm mentioned, when someone replies in a thread I'm in, and when my comment is resolved.
          <span className="block text-muted-foreground">Only if your organisation sends notifications by email. You always see them under the bell.</span>
        </span>
      </label>
    </Page>
  );
}
