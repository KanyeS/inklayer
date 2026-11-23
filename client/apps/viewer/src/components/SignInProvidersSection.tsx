import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@inklayer/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { CopyIcon, ExternalLink } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorText, Loading, SectionTitle } from "@/components/Layout";
import { api, type SignInProvider } from "@/lib/api";
import { queries } from "@/lib/queries";
import { useAction } from "@/lib/query";

const DOCS = "https://github.com/KanyeS/inklayer/blob/main/docs/sso-oidc.md";

/** Common providers: a suggested id and name, what their issuer address looks like, and their section of the guide. */
const PRESETS = {
  okta: { name: "Okta", authority: "https://your-org.okta.com", anchor: "okta", domains: true },
  entra: {
    name: "Microsoft",
    authority: "https://login.microsoftonline.com/<tenant id>/v2.0",
    anchor: "microsoft-entra-id",
    domains: true,
  },
  jumpcloud: { name: "JumpCloud", authority: "https://oauth.id.jumpcloud.com/", anchor: "jumpcloud", domains: true },
  keycloak: {
    name: "Keycloak",
    authority: "https://keycloak.example.com/realms/<realm>",
    anchor: "keycloak",
    domains: false,
  },
  authentik: {
    name: "Authentik",
    authority: "https://authentik.example.com/application/o/inklayer/",
    anchor: "authentik",
    domains: true,
  },
  auth0: { name: "Auth0", authority: "https://your-tenant.eu.auth0.com/", anchor: "auth0", domains: false },
  dex: { name: "Dex", authority: "https://id.example.com", anchor: "running-inklayer-by-yourself", domains: false },
  other: { name: "", authority: "https://idp.example.com", anchor: "any-other-oidc-provider", domains: true },
} as const;
type Preset = keyof typeof PRESETS;

const PRESET_LABELS: Record<Preset, string> = {
  okta: "Okta",
  entra: "Microsoft Entra ID",
  jumpcloud: "JumpCloud",
  keycloak: "Keycloak",
  authentik: "Authentik",
  auth0: "Auth0",
  dex: "Dex",
  other: "Another OpenID Connect provider",
};

type Draft = {
  id: string;
  displayName: string;
  authority: string;
  clientId: string;
  clientSecret: string;
  verifiedDomains: string;
  scopes: string;
};

const EMPTY: Draft = {
  id: "",
  displayName: "",
  authority: "",
  clientId: "",
  clientSecret: "",
  verifiedDomains: "",
  scopes: "openid email profile",
};

/** Instance admins add a second (or third) way to sign in, without editing the server's configuration or restarting it. */
export function SignInProvidersSection() {
  const providers = useQuery(queries.admin.signInProviders());
  const [editing, setEditing] = useState<{
    draft: Draft;
    preset: Preset;
    isNew: boolean;
    needsSecret?: boolean;
  } | null>(null);
  const action = useAction();

  const startAdding = () => {
    action.reset();
    setEditing({ draft: { ...EMPTY, id: "okta", displayName: "Okta" }, preset: "okta", isNew: true });
  };
  const startEditing = (p: SignInProvider) => {
    action.reset();
    setEditing({
      isNew: false,
      needsSecret: p.needsSecret,
      preset: (p.id in PRESETS ? p.id : "other") as Preset,
      draft: {
        id: p.id,
        displayName: p.displayName,
        authority: p.authority ?? "",
        clientId: p.clientId ?? "",
        clientSecret: "",
        verifiedDomains: (p.verifiedDomains ?? []).join(", "),
        scopes: p.scopes ?? EMPTY.scopes,
      },
    });
  };
  const remove = (p: SignInProvider) =>
    action.run(() => api.delete("/api/admin/sign-in-providers/{id}", { params: { path: { id: p.id } } }));

  if (!providers.data) return providers.error ? <ErrorText error={providers.error} /> : <Loading />;
  const { yourProviders, redirectUriPrefix } = providers.data;

  return (
    <section>
      <SectionTitle>Sign-in providers</SectionTitle>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        The ways people can sign in. Add another OpenID Connect provider here, such as your company's Okta or Entra ID
        next to Google: it works as soon as you save, with no restart. Providers set in the server's configuration are
        changed there.{" "}
        <a href={DOCS} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
          Setup guide
        </a>
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead>Set up in</TableHead>
            <TableHead>Accounts</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {providers.data.providers.map((p) => {
            const onlyYours = yourProviders.length === 1 && yourProviders[0] === p.id;
            return (
              <TableRow key={p.id}>
                <TableCell>
                  {p.displayName} <span className="text-muted-foreground">({p.id})</span>
                  {p.needsSecret && (
                    <Badge variant="destructive" className="ml-2">
                      Enter its secret again
                    </Badge>
                  )}
                  {yourProviders.includes(p.id) && (
                    <Badge variant="secondary" className="ml-2">
                      You use this
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {p.source === "Config" ? "Server configuration" : "Added here"}
                </TableCell>
                <TableCell className="text-muted-foreground">{p.accounts}</TableCell>
                <TableCell className="text-right">
                  {p.canRemove && (
                    <span className="inline-flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => startEditing(p)}>
                        Edit
                      </Button>
                      {!onlyYours && providers.data.providers.length > 1 && (
                        <ConfirmButton
                          title={`Remove ${p.displayName}?`}
                          description={
                            p.accounts > 0
                              ? `${p.accounts} ${p.accounts === 1 ? "person has" : "people have"} signed in with it. They'll need another way to sign in.`
                              : "Nobody has signed in with it yet."
                          }
                          confirmLabel="Remove"
                          onConfirm={() => void remove(p)}
                        >
                          Remove
                        </ConfirmButton>
                      )}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {editing ? (
        <ProviderForm
          key={editing.draft.id || "new"}
          initial={editing}
          redirectUriPrefix={redirectUriPrefix}
          onDone={() => setEditing(null)}
        />
      ) : (
        <div className="mt-3">
          <Button variant="outline" onClick={startAdding}>
            Add a provider
          </Button>
        </div>
      )}
      <div className="mt-2">
        <ErrorText error={action.error} />
      </div>
    </section>
  );
}

function ProviderForm({
  initial,
  redirectUriPrefix,
  onDone,
}: {
  initial: { draft: Draft; preset: Preset; isNew: boolean; needsSecret?: boolean };
  redirectUriPrefix: string;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(initial.draft);
  const [preset, setPreset] = useState(initial.preset);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const { isNew } = initial;
  const info = PRESETS[preset];
  const redirectUri = redirectUriPrefix + (draft.id || "<id>");
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const choosePreset = (next: Preset) => {
    setPreset(next);
    if (isNew) set({ id: next === "other" ? "" : next, displayName: PRESETS[next].name });
  };
  const copy = async () => {
    await navigator.clipboard.writeText(redirectUri);
    setCopied(true);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      displayName: draft.displayName,
      authority: draft.authority,
      clientId: draft.clientId,
      // Editing: an empty box keeps the current secret.
      clientSecret: draft.clientSecret || (isNew ? "" : null),
      scopes: draft.scopes,
      verifiedDomains: draft.verifiedDomains.split(/[\s,;]+/).filter(Boolean),
    };
    const saved = await action.run(() =>
      isNew
        ? api.post("/api/admin/sign-in-providers", { body: { ...body, id: draft.id } })
        : api.put("/api/admin/sign-in-providers/{id}", { params: { path: { id: draft.id } }, body }),
    );
    if (saved.ok) onDone();
  };

  return (
    <form className="mt-4 max-w-xl rounded-lg border p-4" onSubmit={save}>
      <FieldGroup className="gap-5">
        <Field>
          <FieldLabel htmlFor="provider-preset">Provider</FieldLabel>
          <NativeSelect
            id="provider-preset"
            value={preset}
            onChange={(e) => choosePreset(e.target.value as Preset)}
            disabled={!isNew}
          >
            {(Object.keys(PRESETS) as Preset[]).map((key) => (
              <NativeSelectOption key={key} value={key}>
                {PRESET_LABELS[key]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>
            <a
              href={`${DOCS}#${info.anchor}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            >
              What to set at {PRESET_LABELS[preset]} <ExternalLink className="size-3" />
            </a>
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="provider-name">Button text</FieldLabel>
          <Input
            id="provider-name"
            value={draft.displayName}
            onChange={(e) => set({ displayName: e.target.value })}
            required
            maxLength={80}
          />
          <FieldDescription>Shown as "Sign in with {draft.displayName || "…"}".</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="provider-id">Id</FieldLabel>
          <Input
            id="provider-id"
            value={draft.id}
            onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
            required
            maxLength={32}
            disabled={!isNew}
          />
          <FieldDescription>Part of the redirect URI, so it can't be changed later.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Redirect URI to register at the provider</FieldLabel>
          <div className="flex items-center gap-2">
            <code className="truncate rounded bg-muted px-2 py-1 text-sm">{redirectUri}</code>
            <Button type="button" variant="ghost" size="sm" onClick={() => void copy()} disabled={!draft.id}>
              <CopyIcon className="size-4" />
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor="provider-authority">Issuer address (authority)</FieldLabel>
          <Input
            id="provider-authority"
            value={draft.authority}
            onChange={(e) => set({ authority: e.target.value })}
            placeholder={info.authority}
            required
          />
          <FieldDescription>
            Checked when you save: the server must be able to read its discovery document.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="provider-client-id">Client ID</FieldLabel>
          <Input
            id="provider-client-id"
            value={draft.clientId}
            onChange={(e) => set({ clientId: e.target.value })}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="provider-secret">Client secret</FieldLabel>
          <Input
            id="provider-secret"
            type="password"
            autoComplete="off"
            value={draft.clientSecret}
            onChange={(e) => set({ clientSecret: e.target.value })}
            placeholder={isNew || initial.needsSecret ? "" : "Leave empty to keep the current secret"}
            required={initial.needsSecret}
          />
          <FieldDescription>
            {initial.needsSecret
              ? "The saved secret can't be read on this server any more (the database was restored without the server's keys), so this provider is off the sign-in page. Enter it again to bring it back."
              : "Stored encrypted, and never shown again."}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="provider-domains">Verified email domains</FieldLabel>
          <Input
            id="provider-domains"
            value={draft.verifiedDomains}
            onChange={(e) => set({ verifiedDomains: e.target.value })}
            placeholder="acme.com"
          />
          <FieldDescription>
            {info.domains ? "Recommended for this provider. " : "Optional. "}
            Domains whose accounts this provider controls: their emails count as verified, people join organisations
            that allow the domain, and existing accounts with the same email are linked. Only list domains this provider
            really owns.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="provider-scopes">Scopes</FieldLabel>
          <Input id="provider-scopes" value={draft.scopes} onChange={(e) => set({ scopes: e.target.value })} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" disabled={action.pending}>
            {action.pending ? "Checking…" : isNew ? "Add provider" : "Save"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
        <ErrorText error={action.error} />
      </FieldGroup>
    </form>
  );
}
