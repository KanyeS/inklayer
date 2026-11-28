import { Button } from "@inklayer/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@inklayer/ui/components/dialog";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { Building2, X } from "lucide-react";
import { useState } from "react";
import { useMe } from "@/App";
import { ErrorText } from "@/components/Layout";
import { useAction } from "@/lib/query";
import { type DocInfo, docsApi } from "../docsApi";

/** Organisation roles that can create docs there, so can share a doc into it. */
const CAN_SHARE_INTO = new Set(["Commenter", "Editor", "Manager", "Admin", "Owner"]);

type Access = "read" | "edit";

function AccessSelect({ value, onChange, label }: { value: Access; onChange: (value: Access) => void; label: string }) {
  return (
    <NativeSelect size="sm" value={value} aria-label={label} onChange={(e) => onChange(e.target.value as Access)}>
      <NativeSelectOption value="edit">Can edit</NativeSelectOption>
      <NativeSelectOption value="read">Can read</NativeSelectOption>
    </NativeSelect>
  );
}

/**
 * Shares the doc with other organisations you're in. It stays one doc: they open the same live text, so it can't get out
 * of step. Only people in the doc's own organisation see this.
 */
export function OrgShareButton({ info }: { info: DocInfo }) {
  const { me } = useMe();
  const [open, setOpen] = useState(false);
  const shares = info.sharedWith ?? [];
  const shared = new Set(shares.map((s) => s.organizationId));
  const candidates = me.organizations.filter(
    (o) => o.id !== info.organizationId && CAN_SHARE_INTO.has(o.role) && !shared.has(o.id),
  );
  if (!info.canManage || (shares.length === 0 && candidates.length === 0)) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        title="Share this doc with another organisation you're in"
        onClick={() => setOpen(true)}
      >
        <Building2 data-icon="inline-start" />
        {shares.length > 0 ? `Shared with ${shares.length}` : "Share with org"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Share with other organisations</DialogTitle>
            <DialogDescription>
              It stays one doc, not a copy: people there open the same live text, and edits from either side show up for
              everyone. Only this organisation can rename, move, delete or share it.
            </DialogDescription>
          </DialogHeader>
          <OrgShareList info={info} candidates={candidates} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function OrgShareList({ info, candidates }: { info: DocInfo; candidates: { id: string; name: string }[] }) {
  const { run, error } = useAction();
  const [orgId, setOrgId] = useState("");
  const [access, setAccess] = useState<Access>("edit");
  const chosen = candidates.some((c) => c.id === orgId) ? orgId : (candidates[0]?.id ?? "");
  const shares = info.sharedWith ?? [];

  return (
    <div className="space-y-4">
      {shares.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {shares.map((s) => (
            <li key={s.organizationId} className="flex items-center gap-2 px-3 py-2">
              <span
                className="min-w-0 flex-1 truncate text-sm font-medium"
                title={`Shared by ${s.sharedBy.displayName}`}
              >
                {s.name}
              </span>
              <AccessSelect
                label={`What ${s.name} can do`}
                value={s.canEdit ? "edit" : "read"}
                onChange={(next) => void run(() => docsApi.shareWithOrg(info.id, s.organizationId, next === "edit"))}
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                title={`Stop sharing with ${s.name}`}
                aria-label={`Stop sharing with ${s.name}`}
                onClick={() => void run(() => docsApi.unshareWithOrg(info.id, s.organizationId))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            size="sm"
            className="min-w-40 flex-1"
            value={chosen}
            aria-label="Organisation"
            onChange={(e) => setOrgId(e.target.value)}
          >
            {candidates.map((c) => (
              <NativeSelectOption key={c.id} value={c.id}>
                {c.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <AccessSelect label="What they can do" value={access} onChange={setAccess} />
          <Button
            size="sm"
            disabled={!chosen}
            onClick={() => void run(() => docsApi.shareWithOrg(info.id, chosen, access === "edit"))}
          >
            Share
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          You can share only with organisations where you're Commenter or above.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        "Can edit" lets their Commenters and above edit the text; their Viewers still only read. An Admin there can also
        stop sharing it with them.
      </p>
      <ErrorText error={error} />
    </div>
  );
}
