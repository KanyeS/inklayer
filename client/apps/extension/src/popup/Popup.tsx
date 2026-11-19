import { Button } from "@inklayer/ui/components/button";
import { Spinner } from "@inklayer/ui/components/spinner";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type StateResponse, send } from "@/lib/messages";
import { type Choice, screenFor } from "./browser";
import { ErrorText } from "./parts";
import { Settings, Setup, SignIn } from "./ServerScreens";
import { SignedIn } from "./SignedIn";

/** The toolbar popup: set up the server, sign in, then comment, live cursors, notifications and docs. */
export function Popup() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>("auto");

  const refresh = useCallback(async () => {
    setChoice("auto");
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
        <Button variant="outline" onClick={() => void refresh()}>
          Retry
        </Button>
      </>
    );
  } else if (!state) {
    body = (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner /> Loading…
      </p>
    );
  } else {
    body = <Screen state={state} choice={choice} onChoose={setChoice} refresh={refresh} />;
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

function Screen({
  state,
  choice,
  onChoose,
  refresh,
}: {
  state: StateResponse;
  choice: Choice;
  onChoose: (choice: Choice) => void;
  refresh: () => Promise<void>;
}) {
  const changeServer = () => onChoose("setup");
  const screen = screenFor(state, choice);
  if (screen === "setup") return <Setup state={state} onDone={refresh} />;
  if (screen === "settings") return <Settings state={state} onChangeServer={changeServer} onBack={refresh} />;
  if (screen === "signIn" || !state.me) return <SignIn state={state} onDone={refresh} onChangeServer={changeServer} />;
  return <SignedIn state={state} me={state.me} onSettings={() => onChoose("settings")} onSignedOut={refresh} />;
}
