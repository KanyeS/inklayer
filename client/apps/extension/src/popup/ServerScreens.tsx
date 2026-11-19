import { Button } from "@inklayer/ui/components/button";
import { Field, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { Spinner } from "@inklayer/ui/components/spinner";
import { type FormEvent, useState } from "react";
import { type StateResponse, send } from "@/lib/messages";
import { normaliseServerUrl, updateSettings } from "@/lib/settings";
import { requestSiteAccess } from "./browser";
import { ErrorText, ServerLine } from "./parts";

/** Connecting to a server and signing in to it. */

/** Which Inklayer server to use. Connecting asks for site access, which reaching it and showing comments need. */
export function Setup({ state, onDone }: { state: StateResponse; onDone: () => Promise<void> }) {
  const [url, setUrl] = useState(state.serverUrl ?? "");
  const [error, setError] = useState("");

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const serverUrl = normaliseServerUrl(url);
      if (!(await requestSiteAccess())) throw new Error("Inklayer needs site access to show comments on pages.");
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
          <Input
            id="server-url"
            type="url"
            placeholder="https://inklayer.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
        </Field>
        <Button type="submit">Connect</Button>
      </form>
      <ErrorText>{error}</ErrorText>
    </>
  );
}

export function SignIn({
  state,
  onDone,
  onChangeServer,
}: {
  state: StateResponse;
  onDone: () => Promise<void>;
  onChangeServer: () => void;
}) {
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
      <Button disabled={busy} onClick={() => void signIn()}>
        {busy && <Spinner data-icon="inline-start" />}Sign in
      </Button>
      <ErrorText>{error}</ErrorText>
      <Button variant="link" className="h-auto self-start px-0" onClick={onChangeServer}>
        Change server
      </Button>
    </>
  );
}

export function Settings({
  state,
  onChangeServer,
  onBack,
}: {
  state: StateResponse;
  onChangeServer: () => void;
  onBack: () => Promise<void>;
}) {
  return (
    <>
      <ServerLine url={state.serverUrl} />
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => void onBack()}>
          Back
        </Button>
        <Button variant="outline" size="sm" onClick={onChangeServer}>
          Change server
        </Button>
      </div>
    </>
  );
}
