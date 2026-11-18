import { useEffect, useState, type FormEvent } from "react";
import { ShieldCheckIcon, ShieldOffIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@inklayer/ui/components/alert";
import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@inklayer/ui/components/field";
import { Textarea } from "@inklayer/ui/components/textarea";
import { ErrorText, Loading, SectionTitle } from "@/components/Layout";
import { get, put, type NetworkAccess } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";

const SOURCE_TEXT: Record<NetworkAccess["source"], string> = {
  None: "Not restricted: Inklayer answers from any network.",
  Config: "Using the starting list from the server's configuration (INKLAYER_ALLOWED_NETWORKS). Saving here replaces it.",
  Admin: "Set by an administrator.",
};

/** Instance admins limit the whole server to the company VPN (or any other networks). */
export function NetworkAccessSection() {
  const network = useAsync(() => get<NetworkAccess>("/api/admin/network"), []);
  const [text, setText] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (network.data) setText(network.data.allowedNetworks.join("\n"));
  }, [network.data]);

  const entries = text.split(/[\s,;]+/).filter(Boolean);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await put<NetworkAccess>("/api/admin/network", { allowedNetworks: entries });
      await network.reload();
      setSaved(true);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  const addMine = () => {
    const mine = network.data?.yourAddress;
    if (mine && !entries.includes(mine)) setText((t) => (t.trim() ? `${t.trim()}\n${mine}` : mine));
  };

  return (
    <>
      <SectionTitle>Network access (VPN)</SectionTitle>
      {!network.data ? (network.error ? <ErrorText error={network.error} /> : <Loading />) : (
        <form className="max-w-xl" onSubmit={save}>
          <FieldGroup className="gap-5">
            {network.data.restrictionDisabled && (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>Switched off in the server's configuration</AlertTitle>
                <AlertDescription>INKLAYER_NETWORK_RESTRICTION_DISABLED is set, so this list isn't enforced. Remove it once you can sign in again.</AlertDescription>
              </Alert>
            )}
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              {network.data.allowedNetworks.length > 0 ? <ShieldCheckIcon className="size-4 text-primary" /> : <ShieldOffIcon className="size-4" />}
              {SOURCE_TEXT[network.data.allowedNetworks.length > 0 ? network.data.source : "None"]}
            </p>
            <Field>
              <FieldLabel htmlFor="allowed-networks">Allowed networks</FieldLabel>
              <Textarea id="allowed-networks" className="min-h-28 font-mono text-sm" value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }}
                placeholder={"10.8.0.0/16\n203.0.113.7"} spellCheck={false} />
              <FieldDescription>
                One address or range per line, e.g. your VPN's exit addresses. Everyone, including the extension, must then connect from one of
                them. Leave empty to allow every network. Health checks and the server itself are always allowed.
              </FieldDescription>
            </Field>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Your address:</span>
              <code>{network.data.yourAddress ?? "unknown"}</code>
              {network.data.allowedNetworks.length > 0 && (network.data.yourAddressAllowed
                ? <Badge variant="secondary">allowed</Badge>
                : <Badge variant="destructive">not in the list</Badge>)}
              {network.data.yourAddress && !entries.includes(network.data.yourAddress) && (
                <Button type="button" variant="link" size="sm" className="h-auto px-1" onClick={addMine}>Add it</Button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={busy}>Save</Button>
              {saved && <span className="text-sm text-muted-foreground">Saved.</span>}
            </div>
            <ErrorText error={error} />
          </FieldGroup>
        </form>
      )}
    </>
  );
}
