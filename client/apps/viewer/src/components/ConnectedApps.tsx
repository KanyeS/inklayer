import { useState } from "react";
import { Bot, Check, Copy } from "lucide-react";
import { Button } from "@inklayer/ui/components/button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorText, SectionTitle } from "@/components/Layout";
import { del, get } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { useAsync } from "@/lib/useAsync";

interface ConnectedApp {
  clientId: string;
  name: string;
  authorizedAt: string | null;
}

/**
 * Apps such as Claude that the person allowed to use Inklayer as them (through the MCP endpoint), with a way to
 * disconnect each, and the address to give a new one.
 */
export function ConnectedApps() {
  const apps = useAsync(() => get<ConnectedApp[]>("/api/me/apps"), []);
  const [error, setError] = useState<Error | null>(null);
  const [copied, setCopied] = useState(false);
  const mcpUrl = `${location.origin}/api/mcp`;

  const disconnect = async (clientId: string) => {
    try {
      await del(`/api/me/apps/${encodeURIComponent(clientId)}`);
      setError(null);
      await apps.reload();
    } catch (e) {
      setError(e as Error);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(mcpUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section>
      <SectionTitle>Connected apps</SectionTitle>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        AI assistants such as Claude can use Inklayer as you: read and reply to comments, and read and edit docs, wherever your role allows.
        Add this MCP server address to the app, then sign in and allow it.
      </p>
      <div className="mb-4 flex max-w-2xl items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-sm">{mcpUrl}</code>
        <Button variant="ghost" size="sm" onClick={() => void copy()}>{copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}{copied ? "Copied" : "Copy"}</Button>
      </div>
      <ErrorText error={error ?? apps.error} />
      {apps.data?.length === 0 && <p className="text-sm text-muted-foreground">No apps connected.</p>}
      <ul className="max-w-2xl divide-y rounded-xl border empty:hidden">
        {apps.data?.map((app) => (
          <li key={app.clientId} className="flex items-center gap-3 px-4 py-3">
            <Bot className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{app.name}</p>
              {app.authorizedAt && <p className="text-xs text-muted-foreground" title={dateTime(app.authorizedAt)}>Allowed {timeAgo(app.authorizedAt)}</p>}
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
