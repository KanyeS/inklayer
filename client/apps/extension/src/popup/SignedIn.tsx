import { Button } from "@inklayer/ui/components/button";
import { useEffect, useState } from "react";
import { type StateResponse, send } from "@/lib/messages";
import { activeTabId, requestSiteAccess } from "./browser";
import { Notifications } from "./Notifications";
import { ErrorText, Hint, OpenDocs, ScreenshotAccess } from "./parts";

const OFF_LIMITS = "(browser pages and extension stores are off limits)";

type Me = NonNullable<StateResponse["me"]>;

/** The main screen: comment on this page, live cursors, notifications and docs. */
export function SignedIn({
  state,
  me,
  onSettings,
  onSignedOut,
}: {
  state: StateResponse;
  me: Me;
  onSettings: () => void;
  onSignedOut: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const footer = <Footer onSettings={onSettings} onSignedOut={onSignedOut} />;

  if (me.organizations.length === 0) {
    return (
      <>
        <p>You're signed in, but not a member of any organisation yet. Ask an administrator to invite you.</p>
        {footer}
      </>
    );
  }

  /** Opens the Inklayer panel on the current page. Its Activity tab holds the activity log. */
  const openPanel = async () => {
    if (!(await requestSiteAccess())) {
      setError("Site access is needed to show comments on pages.");
      return;
    }
    const tabId = await activeTabId();
    if (!tabId) return;
    try {
      await send({ type: "openLive", tabId, view: "comments" });
      window.close();
    } catch {
      setError(`Inklayer can't open on this page ${OFF_LIMITS}.`);
    }
  };

  return (
    <>
      <Button size="lg" onClick={() => void openPanel()}>
        Comment on this page
      </Button>
      <Hint>Comments appear on the page for everyone in your projects who has the extension.</Hint>
      {/* Hidden while an administrator has turned live cursors off. */}
      {me.features.liveCursors && <LiveCursors onError={setError} />}
      <ScreenshotAccess />
      <Notifications />
      {/* Hidden while an administrator has turned docs off. */}
      {me.features.docs && state.serverUrl && <OpenDocs serverUrl={state.serverUrl} organizations={me.organizations} />}
      <ErrorText>{error}</ErrorText>
      {footer}
    </>
  );
}

/** Turns live cursors on or off for the current tab only. */
function LiveCursors({ onError }: { onError: (message: string) => void }) {
  const [live, setLive] = useState<boolean | null>(null);
  useEffect(() => {
    void (async () => {
      const tabId = await activeTabId();
      if (tabId !== null) setLive(await send({ type: "presenceState", tabId }).catch(() => false));
    })();
  }, []);

  const toggle = async () => {
    // The permission request has to come first, inside the click.
    if (!live && !(await requestSiteAccess())) {
      onError("Site access is needed to show live cursors on pages.");
      return;
    }
    const tabId = await activeTabId();
    if (tabId === null) return;
    try {
      await send({ type: "setPresence", tabId, on: !live });
      setLive(!live);
      onError("");
    } catch {
      onError(`Live cursors can't run on this page ${OFF_LIMITS}.`);
    }
  };

  return (
    <>
      <Button variant={live ? "secondary" : "outline"} disabled={live === null} onClick={() => void toggle()}>
        {live && (
          <span aria-hidden className="size-2 rounded-full bg-[#0ACF83] shadow-[0_0_0_3px_rgb(10_207_131/0.2)]" />
        )}
        {live ? "Stop live cursors on this tab" : "Live cursors on this tab"}
      </Button>
      <Hint>
        {live
          ? "People in your organisations who are on this page with live cursors on see your pointer and selections. Only this tab shares."
          : "See the pointers and selections of people in your organisations on the same page, and share yours. Only this tab, until you close it."}
      </Hint>
    </>
  );
}

function Footer({ onSettings, onSignedOut }: { onSettings: () => void; onSignedOut: () => Promise<void> }) {
  const signOut = async () => {
    await send({ type: "signOut" });
    await onSignedOut();
  };
  return (
    <div className="mt-1 flex items-center justify-between border-t pt-3">
      <Button variant="ghost" size="sm" onClick={onSettings}>
        Settings
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}
