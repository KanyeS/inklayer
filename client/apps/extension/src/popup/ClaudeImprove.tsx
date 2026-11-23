import { Button } from "@inklayer/ui/components/button";
import { useEffect, useState } from "react";
import { type HelperStatus, NATIVE_MESSAGING, pluginCommand } from "@/lib/claude-helper";
import { type InstallerOs, installerFor } from "@/lib/helper-installers";
import { send } from "@/lib/messages";
import { ErrorText } from "./parts";

/**
 * Turns the Improve button in the comment box on or off. It rewrites drafts with the Claude Code CLI on this computer
 * (the person's own Claude plan) through a small helper, set up once: with Inklayer's Claude Code plugin, or an
 * installer downloaded here.
 */
export function ClaudeImprove({ serverUrl }: { serverUrl: string }) {
  const [status, setStatus] = useState<HelperStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const check = async (request: Parameters<typeof send>[0]) => {
    setBusy(true);
    setError("");
    try {
      setStatus((await send(request)) as HelperStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: check once, when the popup opens
  useEffect(() => void check({ type: "claudeStatus" }), []);

  const toggle = async () => {
    const on = !status?.enabled;
    // The permission request has to come first, inside the click.
    if (on && !(await chrome.permissions.request(NATIVE_MESSAGING))) {
      setError("Inklayer needs permission to talk to the helper on this computer.");
      return;
    }
    await check({ type: "setClaudeImprove", on });
  };

  const enabled = status?.enabled ?? false;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border p-2 text-xs">
      <Button
        size="sm"
        variant={enabled ? "secondary" : "outline"}
        disabled={status === null || busy}
        onClick={() => void toggle()}
      >
        {busy ? "Checking…" : enabled ? "Turn off Improve with Claude" : "Improve comments with Claude"}
      </Button>
      <p className="text-muted-foreground">
        Adds an Improve button to the comment box: it turns a rough draft into a clear comment and, when you ask for
        ideas, suggests options from the page. It uses Claude Code on this computer, with your own Claude plan; your
        draft and the page's text go to Claude, not to Inklayer, until you save.
      </p>
      {status?.enabled && status.ready && <p>Ready{status.claude ? ` (${status.claude})` : ""}.</p>}
      {status?.enabled && !status.ready && (
        <>
          <p className="text-destructive">{status.error ?? "The helper isn't set up yet."}</p>
          {status.permission && <SetUp serverUrl={serverUrl} />}
          {status.permission && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void check({ type: "claudeStatus" })}>
              Check again
            </Button>
          )}
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** Setting the helper up, once per computer: Claude Code's plugin, or an installer for this system. */
function SetUp({ serverUrl }: { serverUrl: string }) {
  const [os, setOs] = useState<InstallerOs | null>(null);
  const [copied, setCopied] = useState(false);
  const [howTo, setHowTo] = useState("");
  useEffect(() => {
    void chrome.runtime
      .getPlatformInfo()
      .then((info) =>
        setOs(info.os === "mac" ? "mac" : info.os === "win" ? "win" : info.os === "linux" ? "linux" : null),
      );
  }, []);

  const command = pluginCommand(serverUrl);
  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  };
  const download = () => {
    if (!os) return;
    const file = installerFor(os);
    const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setHowTo(file.howTo);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-muted-foreground">
        Set it up once on this computer. It needs Claude Code and Node.js. With Claude Code, run this in a terminal (it
        also adds Claude's page reviews), then restart Claude Code:
      </p>
      <div className="flex items-center gap-1">
        <code className="min-w-0 flex-1 break-all rounded bg-muted px-1 py-0.5">{command}</code>
        <Button size="sm" variant="ghost" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {os && (
        <>
          <p className="text-muted-foreground">Or download an installer and open it:</p>
          <Button size="sm" variant="outline" onClick={download}>
            Download installer
          </Button>
          {howTo && <p className="text-muted-foreground">{howTo}</p>}
        </>
      )}
    </div>
  );
}
