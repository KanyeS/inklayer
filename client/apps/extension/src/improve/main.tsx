import { Spinner } from "@inklayer/ui/components/spinner";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { type StateResponse, send } from "@/lib/messages";
import { ClaudeImprove } from "@/popup/ClaudeImprove";
import { ErrorText } from "@/popup/parts";
import "./improve.css";

/**
 * Setting up the Improve button, in a tab of its own: the comment box's "Improve with Claude: set up" link opens it,
 * since a web page can't open the toolbar popup. The same controls as the popup's Settings.
 */
function ImproveSetup() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void send({ type: "state" })
      .then(setState)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 p-8 text-sm">
      <h1 className="font-heading text-xl font-bold tracking-tight">Improve comments with Claude</h1>
      <p className="text-muted-foreground">
        An Improve button in Inklayer's comment box rewrites a rough draft into a clear comment, keeping your meaning,
        @mentions and links. It uses Claude Code on this computer, with your own Claude plan. Set it up once here, then
        come back to the page and look for Improve next to Save.
      </p>
      <ErrorText>{error}</ErrorText>
      {!state && !error && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner /> Loading…
        </p>
      )}
      {state && !(state.signedIn && state.serverUrl) && (
        <p>Sign in to Inklayer from the toolbar button first, then open this again.</p>
      )}
      {state?.signedIn && state.serverUrl && <ClaudeImprove serverUrl={state.serverUrl} />}
    </main>
  );
}

// Follow the system light/dark setting, as the popup does.
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
const applyScheme = () => document.documentElement.classList.toggle("dark", darkScheme.matches);
applyScheme();
darkScheme.addEventListener("change", applyScheme);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ImproveSetup />
    </StrictMode>,
  );
}
