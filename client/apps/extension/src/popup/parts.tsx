import { Button } from "@inklayer/ui/components/button";
import { type ReactNode, useEffect, useState } from "react";
import { send } from "@/lib/messages";
import { openInNewTab, requestSiteAccess, SITE_ACCESS } from "./browser";

/** Small pieces several popup screens use. */

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-destructive">
      {children}
    </p>
  );
}

/** "Server: https://…" */
export function ServerLine({ url }: { url: string | null }) {
  return (
    <p className="text-xs text-muted-foreground">
      Server: <code className="break-all">{url ?? ""}</code>
    </p>
  );
}

/** Small print under a button. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/**
 * Screenshots with comments need access to all sites in the form browsers ask for ("<all_urls>"). Earlier versions asked
 * for every http and https site instead, which doesn't count, so people who allowed that are asked once more here.
 */
export function ScreenshotAccess() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => void chrome.permissions.contains(SITE_ACCESS).then(setAllowed), []);
  if (allowed !== false) return null;
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border p-2 text-center text-xs">
      <p className="text-muted-foreground">Screenshots with comments need one more permission.</p>
      <Button size="sm" variant="outline" onClick={async () => setAllowed(await requestSiteAccess())}>
        Allow screenshots
      </Button>
    </div>
  );
}

/** Opens the organisation's docs in the web viewer. With several organisations, lists them to pick from. */
export function OpenDocs({
  serverUrl,
  organizations,
}: {
  serverUrl: string;
  organizations: { id: string; name: string }[];
}) {
  const [picking, setPicking] = useState(false);
  const openDocs = (orgId: string) => void openInNewTab(`${serverUrl}/orgs/${encodeURIComponent(orgId)}/docs`);
  const [only] = organizations;
  if (organizations.length === 1 && only) {
    return (
      <Button variant="outline" onClick={() => openDocs(only.id)}>
        Open docs
      </Button>
    );
  }
  return (
    <>
      <Button variant={picking ? "secondary" : "outline"} aria-expanded={picking} onClick={() => setPicking(!picking)}>
        Open docs
      </Button>
      {picking && (
        <div className="flex flex-col gap-1">
          {organizations.map((o) => (
            <Button key={o.id} variant="ghost" size="sm" className="justify-start" onClick={() => openDocs(o.id)}>
              {o.name}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Points to the web app's setup for AI assistants (Claude Code, VS Code, Cursor...). Shown only until the person has
 * connected one, and hidden if the server can't say.
 */
export function ConnectAssistant({ serverUrl }: { serverUrl: string }) {
  const [connected, setConnected] = useState<number | null>(null);
  useEffect(() => {
    void send({ type: "connectedApps" })
      .then(setConnected)
      .catch(() => setConnected(null));
  }, []);
  if (connected !== 0) return null;
  return (
    <>
      <Button variant="outline" onClick={() => void openInNewTab(`${serverUrl}/#connected-apps`)}>
        Connect an AI assistant
      </Button>
      <Hint>Let Claude or your editor read and resolve comments for you.</Hint>
    </>
  );
}
