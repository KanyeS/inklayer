import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@inklayer/ui/components/button";
import { Field, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { Spinner } from "@inklayer/ui/components/spinner";
import { send, type StateResponse } from "@/lib/messages";
import { normaliseServerUrl, updateSettings } from "@/lib/settings";

const SITE_ACCESS: chrome.permissions.Permissions = { origins: ["https://*/*", "http://*/*"] };

/** Screens the user moves to by hand; otherwise the screen follows the sign-in state. */
type Screen = "auto" | "setup" | "settings";

export function Popup() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("auto");

  const refresh = useCallback(async () => {
    setScreen("auto");
    try {
      setState(await send({ type: "state" }));
      setLoadError(null);
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  let body: ReactNode;
  if (loadError) {
    body = (
      <>
        <ErrorText>{loadError}</ErrorText>
        <Button variant="outline" onClick={() => void refresh()}>Retry</Button>
      </>
    );
  } else if (!state) {
    body = <p className="flex items-center gap-2 text-muted-foreground"><Spinner /> Loading…</p>;
  } else if (screen === "setup" || !state.serverUrl) {
    body = <Setup state={state} onDone={refresh} />;
  } else if (screen === "settings") {
    body = <Settings state={state} onChangeServer={() => setScreen("setup")} onBack={refresh} />;
  } else if (!state.signedIn || !state.me) {
    body = <SignIn state={state} onDone={refresh} onChangeServer={() => setScreen("setup")} />;
  } else {
    body = <SignedIn state={state} onSettings={() => setScreen("settings")} onSignedOut={refresh} />;
  }

  return (
    <div className="flex flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <span className="font-heading text-base font-bold tracking-tight">Inklayer</span>
        <span className="truncate text-xs text-muted-foreground">{state?.me?.email}</span>
      </header>
      <main className="flex flex-col gap-3 p-4 text-sm">{body}</main>
    </div>
  );
}

function Setup({ state, onDone }: { state: StateResponse; onDone: () => Promise<void> }) {
  const [url, setUrl] = useState(state.serverUrl ?? "");
  const [error, setError] = useState("");

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const serverUrl = normaliseServerUrl(url);
      // Needed to reach the server, and to show comments on the pages you visit.
      if (!(await chrome.permissions.request(SITE_ACCESS))) throw new Error("Inklayer needs site access to show comments on pages.");
      await updateSettings({ serverUrl, tokens: null });
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <form className="flex flex-col gap-3" onSubmit={connect}>
        <Field>
          <FieldLabel htmlFor="server-url">Inklayer server</FieldLabel>
          <Input id="server-url" type="url" placeholder="https://inklayer.example.com" value={url} onChange={(e) => setUrl(e.target.value)} required />
        </Field>
        <Button type="submit">Connect</Button>
      </form>
      <ErrorText>{error}</ErrorText>
      <p className="text-xs text-muted-foreground">Ask your administrator to allow this extension's sign-in address:</p>
      <Code>{state.redirectUri}</Code>
    </>
  );
}

function SignIn({ state, onDone, onChangeServer }: { state: StateResponse; onDone: () => Promise<void>; onChangeServer: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signIn = async () => {
    setBusy(true);
    setError("");
    try {
      await send({ type: "signIn" });
      await onDone();
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  };
  return (
    <>
      <ServerLine url={state.serverUrl} />
      <Button disabled={busy} onClick={() => void signIn()}>{busy && <Spinner data-icon="inline-start" />}Sign in</Button>
      <ErrorText>{error}</ErrorText>
      <Button variant="link" className="h-auto self-start px-0" onClick={onChangeServer}>Change server</Button>
    </>
  );
}

function SignedIn({ state, onSettings, onSignedOut }: { state: StateResponse; onSettings: () => void; onSignedOut: () => Promise<void> }) {
  const [error, setError] = useState("");
  const footer = (
    <div className="mt-1 flex items-center justify-between border-t pt-3">
      <Button variant="ghost" size="sm" onClick={onSettings}>Settings</Button>
      <Button variant="ghost" size="sm" onClick={async () => { await send({ type: "signOut" }); await onSignedOut(); }}>Sign out</Button>
    </div>
  );

  if (state.me!.organizations.length === 0) {
    return <><p>You're signed in, but not a member of any organisation yet. Ask an administrator to invite you.</p>{footer}</>;
  }

  /** Opens the Inklayer panel on the current page, on its comments or its activity log. */
  const open = async (view: "comments" | "activity") => {
    // Ask before any other await: Firefox only allows permission requests directly inside the click.
    // If access is already granted, this returns true without prompting.
    if (!(await chrome.permissions.request(SITE_ACCESS))) {
      setError("Site access is needed to show comments on pages.");
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      await send({ type: "openLive", tabId: tab.id, view });
      window.close();
    } catch {
      setError("Inklayer can't open on this page (browser pages and extension stores are off limits).");
    }
  };

  return (
    <>
      <Button size="lg" onClick={() => void open("comments")}>Comment on this page</Button>
      <p className="text-xs text-muted-foreground">Comments appear on the page for everyone in your projects who has the extension.</p>
      <Button variant="outline" title="Who commented where; admins also see sign-ins and errors" onClick={() => void open("activity")}>Activity log</Button>
      <ErrorText>{error}</ErrorText>
      {footer}
    </>
  );
}

function Settings({ state, onChangeServer, onBack }: { state: StateResponse; onChangeServer: () => void; onBack: () => Promise<void> }) {
  return (
    <>
      <ServerLine url={state.serverUrl} />
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => void onBack()}>Back</Button>
        <Button variant="outline" size="sm" onClick={onChangeServer}>Change server</Button>
      </div>
    </>
  );
}

function ServerLine({ url }: { url: string | null }) {
  return <p className="text-xs text-muted-foreground">Server: <Code>{url ?? ""}</Code></p>;
}

function Code({ children }: { children: ReactNode }) {
  return <code className="break-all">{children}</code>;
}

function ErrorText({ children }: { children: ReactNode }) {
  return children ? <p role="alert" className="text-destructive">{children}</p> : null;
}
