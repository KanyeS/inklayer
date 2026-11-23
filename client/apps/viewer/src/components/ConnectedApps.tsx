import { Button } from "@inklayer/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Bot, Check, Copy, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMe } from "@/App";
import { ConfirmButton } from "@/components/ConfirmButton";
import { GuideLink } from "@/components/GuideLink";
import { ErrorText, SectionTitle } from "@/components/Layout";
import { api } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { queries } from "@/lib/queries";
import { useAction } from "@/lib/query";

/** The section's anchor; the extension links to it. */
const SECTION_ID = "connected-apps";

/** The server name assistants list the tools under. */
const NAME = "inklayer";

/**
 * Apps such as Claude that the person allowed to use Inklayer as them (through the MCP endpoint), with a way to
 * disconnect each, and how to add a new one.
 */
export function ConnectedApps() {
  const { me } = useMe();
  const apps = useQuery(queries.connectedApps());
  const action = useAction();
  const mcpUrl = `${location.origin}/api/mcp`;
  const section = useRef<HTMLElement>(null);

  // The extension links here as /#connected-apps; scroll once the list has loaded and the layout is settled.
  useEffect(() => {
    if (apps.isFetched && location.hash === `#${SECTION_ID}`) section.current?.scrollIntoView({ block: "start" });
  }, [apps.isFetched]);

  const disconnect = (clientId: string) =>
    action.run(() => api.delete("/api/me/apps/{clientId}", { params: { path: { clientId } } }));

  return (
    <section id={SECTION_ID} ref={section} className="scroll-mt-6">
      <SectionTitle>Connected apps</SectionTitle>
      {me.features.mcp ? (
        <>
          <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
            AI assistants such as Claude can use Inklayer as you: read and reply to comments, and read and edit docs,
            wherever your role allows. Add this MCP server address to the app, then sign in and allow it.{" "}
            <GuideLink section="ai-assistants-mcp" />
          </p>
          <CopyField value={mcpUrl} className="mb-4" />
          <McpSetup url={mcpUrl} />
        </>
      ) : (
        <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
          AI assistants are turned off on this server. Apps you connected before can't use Inklayer while it's off; you
          can still disconnect them here.
        </p>
      )}
      <ReviewSetup server={location.origin} />
      <ErrorText error={action.error ?? apps.error} />
      {apps.data?.length === 0 && <p className="text-sm text-muted-foreground">No apps connected.</p>}
      <ul className="max-w-2xl divide-y rounded-xl border empty:hidden">
        {apps.data?.map((app) => (
          <li key={app.clientId} className="flex items-center gap-3 px-4 py-3">
            <Bot className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{app.name}</p>
              {app.authorizedAt && (
                <p className="text-xs text-muted-foreground" title={dateTime(app.authorizedAt)}>
                  Allowed {timeAgo(app.authorizedAt)}
                </p>
              )}
            </div>
            <ConfirmButton
              title={`Disconnect ${app.name}?`}
              description="It loses access straight away. To use it again, it has to ask you again."
              confirmLabel="Disconnect"
              onConfirm={() => void disconnect(app.clientId)}
            >
              Disconnect
            </ConfirmButton>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Ready-made setup for the common assistants. The editors install from a link and open the browser to sign in on
 * their own. Claude Code's native HTTP transport waits for `/mcp`; mcp-remote runs the sign-in itself and opens the
 * browser on first start. The server only registers public (PKCE) clients, so mcp-remote must be told to be one.
 */
function McpSetup({ url }: { url: string }) {
  const vscode = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: NAME, type: "http", url }))}`;
  const cursor = `cursor://anysphere.cursor-deeplink/mcp/install?name=${NAME}&config=${btoa(JSON.stringify({ url }))}`;
  const claudeCode = `claude mcp add --transport http ${NAME} ${url}`;
  const claudeCodeAutoSignIn = `claude mcp add ${NAME} -- npx -y mcp-remote ${url} --static-oauth-client-metadata '{"token_endpoint_auth_method":"none"}'`;

  return (
    <div className="mb-6 max-w-2xl space-y-4 text-sm">
      <div>
        <p className="mb-2 font-medium">Install in an editor</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" nativeButton={false} render={<a href={vscode} />}>
            <ExternalLink data-icon="inline-start" />
            Add to VS Code
          </Button>
          <Button variant="outline" size="sm" nativeButton={false} render={<a href={cursor} />}>
            <ExternalLink data-icon="inline-start" />
            Add to Cursor
          </Button>
        </div>
      </div>
      <div>
        <p className="mb-1 font-medium">Claude Code</p>
        <p className="mb-2 text-muted-foreground">Run this, then type /mcp in Claude Code and sign in.</p>
        <CopyField value={claudeCode} />
      </div>
      <div>
        <p className="mb-1 font-medium">Claude Code, signing in on start</p>
        <p className="mb-2 text-muted-foreground">
          Needs Node.js. Opens your browser to sign in the first time Claude Code starts.
        </p>
        <CopyField value={claudeCodeAutoSignIn} />
      </div>
      <div>
        <p className="mb-1 font-medium">Claude Desktop or claude.ai</p>
        <p className="text-muted-foreground">
          In Settings → Connectors, add a custom connector with the address above.
        </p>
      </div>
    </div>
  );
}

/**
 * The review helper (client/apps/review, installed with Inklayer's Claude Code plugin): Claude Code tries pages in a
 * browser and leaves comments with screenshots and recordings. It signs in as a built-in app, not through MCP, so it's
 * offered whether or not AI assistants are on.
 */
function ReviewSetup({ server }: { server: string }) {
  const install = `claude plugin marketplace add KanyeS/inklayer && claude plugin install inklayer@inklayer --config server_url=${server}`;
  const browser = "npx -y playwright-core@1.65.1 install chromium";
  return (
    <div className="mb-6 max-w-2xl space-y-2 text-sm">
      <p className="font-medium">Claude Code, reviewing pages in a browser</p>
      <p className="text-muted-foreground">
        Claude tries a page or feature and leaves comments on what it finds, with screenshots, page details and
        recordings, as you. Install Inklayer's Claude Code plugin and the browser it drives, then restart Claude Code.
        The first time Claude comments, your browser opens to sign in and allow it. The plugin also sets up the
        extension's Improve button.
      </p>
      <CopyField value={install} />
      <CopyField value={browser} />
    </div>
  );
}

/** A one-line value with a copy button. */
function CopyField({ value, className = "" }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className={`flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2 ${className}`}>
      <code className="min-w-0 flex-1 truncate text-sm" title={value}>
        {value}
      </code>
      <Button variant="ghost" size="sm" onClick={() => void copy()}>
        {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
