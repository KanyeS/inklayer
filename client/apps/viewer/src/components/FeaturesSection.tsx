import type { FeatureSettingResponse } from "@inklayer/api";
import { Badge } from "@inklayer/ui/components/badge";
import { Checkbox } from "@inklayer/ui/components/checkbox";
import { useState } from "react";
import { useMe } from "@/App";
import { ErrorText, Loading, SectionTitle } from "@/components/Layout";
import { api, type Features } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";

type FeatureSetting = FeatureSettingResponse & { feature: keyof Features };

/** The startup setting for each feature, for telling admins which variable sets it. */
const ENV_NAMES: Record<FeatureSetting["feature"], string> = {
  docs: "INKLAYER_FEATURE_DOCS",
  liveCursors: "INKLAYER_FEATURE_LIVE_CURSORS",
  mcp: "INKLAYER_FEATURE_MCP",
  bugContext: "INKLAYER_FEATURE_BUG_CONTEXT",
  issueTrackers: "INKLAYER_FEATURE_ISSUE_TRACKERS",
  sharing: "INKLAYER_FEATURE_SHARING",
};

/** Instance admins turn major features on or off for everyone. Changes apply straight away. */
export function FeaturesSection() {
  const { reloadMe } = useMe();
  const features = useAsync(() => api.get("/api/admin/features") as Promise<FeatureSetting[]>, []);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (feature: FeatureSetting, enabled: boolean) => {
    setBusy(feature.feature);
    setError(null);
    try {
      await api.put("/api/admin/features", { body: { [feature.feature]: enabled } });
      await features.reload();
      await reloadMe();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <SectionTitle>Features</SectionTitle>
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        Turn features on or off for everyone on this server. Page comments are always on. Turning a feature off hides it
        in the web app and the extension and closes its live connections; nothing is deleted, and turning it back on
        brings everything back.
      </p>
      <ErrorText error={error ?? features.error} />
      {!features.data ? (
        <Loading />
      ) : (
        <ul className="max-w-2xl divide-y rounded-xl border">
          {features.data.map((f) => (
            <li key={f.feature} className="flex items-start gap-3 px-4 py-3">
              <Checkbox
                id={`feature-${f.feature}`}
                className="mt-1"
                checked={f.enabled}
                disabled={busy !== null}
                onCheckedChange={(checked) => void toggle(f, checked === true)}
              />
              <label htmlFor={`feature-${f.feature}`} className="min-w-0 flex-1 cursor-pointer">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {f.name}
                  <Badge variant={f.enabled ? "secondary" : "outline"}>{f.enabled ? "On" : "Off"}</Badge>
                </span>
                <span className="mt-0.5 block text-sm text-muted-foreground">{f.description}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {f.source === "Admin"
                    ? `Set by an administrator. The server's own setting is ${f.configured ? "on" : "off"}.`
                    : f.source === "Config"
                      ? `Off in the server's configuration (${ENV_NAMES[f.feature]}=false). Turning it on here overrides that.`
                      : "On by default."}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
