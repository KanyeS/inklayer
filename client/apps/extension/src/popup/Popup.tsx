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
  const [live, setLive] = useState<boolean | null>(null);
  useEffect(() => {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined) setLive(await send({ type: "presenceState", tabId: tab.id }).catch(() => false));
    })();
  }, []);
  const footer = (
    <div className="mt-1 flex items-center justify-between border-t pt-3">
      <Button variant="ghost" size="sm" onClick={onSettings}>Settings</Button>
      <Button variant="ghost" size="sm" onClick={async () => { await send({ type: "signOut" }); await onSignedOut(); }}>Sign out</Button>
    </div>
  );

  if (state.me!.organizations.length === 0) {
    return <><p>You're signed in, but not a member of any organisation yet. Ask an administrator to invite you.</p>{footer}</>;
  }

  /** Opens the Inklayer panel on the current page. Its Activity tab holds the activity log. */
  const openPanel = async () => {
    // Ask before any other await: Firefox only allows permission requests directly inside the click.
    // If access is already granted, this returns true without prompting.
    if (!(await chrome.permissions.request(SITE_ACCESS))) {
      setError("Site access is needed to show comments on pages.");
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      await send({ type: "openLive", tabId: tab.id, view: "comments" });
      window.close();
    } catch {
      setError("Inklayer can't open on this page (browser pages and extension stores are off limits).");
    }
  };

  /** Turns live cursors on or off for the current tab only. */
  const toggleLive = async () => {
    // As above: the permission request has to come first, inside the click.
    if (!live && !(await chrome.permissions.request(SITE_ACCESS))) {
      setError("Site access is needed to show live cursors on pages.");
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;
    try {
      await send({ type: "setPresence", tabId: tab.id, on: !live });
      setLive(!live);
      setError("");
    } catch {
      setError("Live cursors can't run on this page (browser pages and extension stores are off limits).");
    }
  };

  return (
    <>
      <Button size="lg" onClick={() => void openPanel()}>Comment on this page</Button>
      <p className="text-xs text-muted-foreground">Comments appear on the page for everyone in your projects who has the extension.</p>
      {/* Hidden while an administrator has turned live cursors off. */}
      {state.me!.features.liveCursors && (
        <>
          <Button variant={live ? "secondary" : "outline"} disabled={live === null} onClick={() => void toggleLive()}>
            {live && <span aria-hidden className="size-2 rounded-full bg-[#0ACF83] shadow-[0_0_0_3px_rgb(10_207_131/0.2)]" />}
            {live ? "Stop live cursors on this tab" : "Live cursors on this tab"}
          </Button>
          <p className="text-xs text-muted-foreground">
            {live
              ? "People in your organisations who are on this page with live cursors on see your pointer and selections. Only this tab shares."
              : "See the pointers and selections of people in your organisations on the same page, and share yours. Only this tab, until you close it."}
          </p>
        </>
      )}
      {/* Hidden while an administrator has turned docs off. */}
      {state.me!.features.docs && <OpenDocs serverUrl={state.serverUrl!} organizations={state.me!.organizations} />}
      <ErrorText>{error}</ErrorText>
      {footer}
    </>
  );
}

/** Opens the organisation's docs in the web viewer. With several organisations, lists them to pick from. */
function OpenDocs({ serverUrl, organizations }: { serverUrl: string; organizations: { id: string; name: string }[] }) {
  const [picking, setPicking] = useState(false);
  const openDocs = async (orgId: string) => {
    await chrome.tabs.create({ url: `${serverUrl}/orgs/${encodeURIComponent(orgId)}/docs` });
    window.close();
  };
  if (organizations.length === 1) {
    return <Button variant="outline" onClick={() => void openDocs(organizations[0]!.id)}>Open docs</Button>;
  }
  return (
    <>
      <Button variant={picking ? "secondary" : "outline"} aria-expanded={picking} onClick={() => setPicking(!picking)}>Open docs</Button>
      {picking && (
        <div className="flex flex-col gap-1">
          {organizations.map((o) => (
            <Button key={o.id} variant="ghost" size="sm" className="justify-start" onClick={() => void openDocs(o.id)}>{o.name}</Button>
          ))}
        </div>
      )}
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
