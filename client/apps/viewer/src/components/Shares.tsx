import type { ShareResponse } from "@inklayer/api";
import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Checkbox } from "@inklayer/ui/components/checkbox";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { Check, Copy, Globe, Link2 } from "lucide-react";
import { useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorText } from "@/components/Layout";
import { api } from "@/lib/api";
import { dateTime, hostOf, timeAgo } from "@/lib/format";
import { useAsync } from "@/lib/useAsync";

export type Share = ShareResponse;

function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}

function describe(s: Share): string {
  if (s.kind === "doc") return `Doc: ${s.docTitle ?? "deleted"}`;
  if (s.kind === "project") return `All pages${s.projectName ? ` in ${s.projectName}` : ""}`;
  return s.pageUrl ? `${hostOf(s.pageUrl)}${safePath(s.pageUrl)}` : "A page";
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function ShareList({
  shares,
  onRevoked,
  showOwner,
}: {
  shares: Share[];
  onRevoked: () => Promise<void>;
  showOwner?: boolean;
}) {
  const [error, setError] = useState<Error | null>(null);
  return (
    <>
      <ErrorText error={error} />
      <ul className="divide-y rounded-xl border empty:hidden">
        {shares.map((s) => (
          <li key={s.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
            <Link2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                <span className="truncate" title={s.pageUrl ?? undefined}>
                  {describe(s)}
                </span>
                {s.includeResolved && <Badge variant="outline">With resolved</Badge>}
                {s.expired && <Badge variant="secondary">Expired</Badge>}
              </p>
              <p className="text-sm text-muted-foreground">
                {showOwner && s.projectName && s.kind !== "project" ? `${s.projectName} · ` : ""}By {s.createdBy}{" "}
                {timeAgo(s.createdAt)}
                {" · "}
                {s.viewCount === 1 ? "1 view" : `${s.viewCount} views`}
                {s.lastViewedAt ? `, last ${timeAgo(s.lastViewedAt)}` : ""}
                {s.expiresAt && !s.expired && ` · until ${dateTime(s.expiresAt)}`}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {!s.expired && <CopyButton url={s.url} />}
              {s.canRevoke && (
                <ConfirmButton
                  title="Turn off this link?"
                  description="It stops working straight away, for everyone who has it."
                  confirmLabel="Turn off"
                  onConfirm={async () => {
                    try {
                      await api.delete("/api/shares/{id}", { params: { path: { id: s.id } } });
                      setError(null);
                    } catch (e) {
                      setError(e as Error);
                    }
                    await onRevoked();
                  }}
                >
                  Turn off
                </ConfirmButton>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A project's read-only links: make one for all its comments here; page links are made from the extension. */
export function ProjectSharesSection({ projectId }: { projectId: string }) {
  const shares = useAsync(() => api.get("/api/shares", { params: { query: { projectId } } }), [projectId]);
  const [includeResolved, setIncludeResolved] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState("30");
  const [error, setError] = useState<Error | null>(null);

  const create = async () => {
    try {
      const created = await api.post("/api/shares", {
        body: {
          kind: "project",
          projectId,
          includeResolved,
          expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
        },
      });
      await navigator.clipboard.writeText(created.url).catch(() => undefined);
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
    await shares.reload();
  };

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Read-only links show comments to people without an account, even outside your network. They see names, comments,
        replies and screenshots; nothing else. To share one page, use “Share this page” in the extension.
      </p>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
        <Button onClick={() => void create()}>
          <Link2 data-icon="inline-start" />
          Create link to all comments
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={includeResolved} onCheckedChange={(on) => setIncludeResolved(on === true)} />
          Include resolved
        </label>
        <NativeSelect aria-label="Expires" value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)}>
          <NativeSelectOption value="7">Expires in 7 days</NativeSelectOption>
          <NativeSelectOption value="30">Expires in 30 days</NativeSelectOption>
          <NativeSelectOption value="90">Expires in 90 days</NativeSelectOption>
          <NativeSelectOption value="">Never expires</NativeSelectOption>
        </NativeSelect>
        <ErrorText error={error ?? shares.error} />
      </div>
      {shares.data?.length === 0 && <p className="text-sm text-muted-foreground">No links yet.</p>}
      <ShareList shares={shares.data ?? []} onRevoked={shares.reload} />
    </div>
  );
}

/** "Make public" for a doc: one read-only link, which Commenters and above can turn on and off. */
export function DocShareButton({ docId, canEdit }: { docId: string; canEdit: boolean }) {
  const shares = useAsync(() => api.get("/api/shares", { params: { query: { docId } } }), [docId]);
  const [error, setError] = useState<Error | null>(null);
  const [copied, setCopied] = useState(false);
  const live = shares.data?.find((s) => !s.expired);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
    await shares.reload();
  };

  if (!live) {
    if (!canEdit) return null;
    return (
      <span className="inline-flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          title="Anyone with the link can read this doc, without an account"
          onClick={() =>
            void run(async () => {
              const created = await api.post("/api/shares", { body: { kind: "doc", docId } });
              await navigator.clipboard.writeText(created.url).catch(() => undefined);
            })
          }
        >
          <Globe data-icon="inline-start" />
          Make public
        </Button>
        <ErrorText error={error} />
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="outline" title={`Anyone with the link can read this doc. ${live.viewCount} views.`}>
        <Globe data-icon="inline-start" />
        Public
      </Badge>
      <Button
        variant="ghost"
        size="sm"
        onClick={async () => {
          await navigator.clipboard.writeText(live.url);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </Button>
      {live.canRevoke && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void run(() => api.delete("/api/shares/{id}", { params: { path: { id: live.id } } }))}
        >
          Make private
        </Button>
      )}
      <ErrorText error={error} />
    </span>
  );
}

/** Every working link on the server, for instance administrators. */
export function AdminSharesSection() {
  const shares = useAsync(() => api.get("/api/admin/shares"), []);
  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Every read-only link that works right now. Turn one off to stop it at once, or turn Sharing off under Features
        to stop them all.
      </p>
      <ErrorText error={shares.error} />
      {shares.data?.length === 0 && <p className="text-sm text-muted-foreground">No links.</p>}
      <ShareList shares={shares.data ?? []} onRevoked={shares.reload} showOwner />
    </div>
  );
}
