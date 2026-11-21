import { Button } from "@inklayer/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMe } from "@/App";
import { ConfirmButton } from "@/components/ConfirmButton";
import { GuideLink } from "@/components/GuideLink";
import { ErrorText, SectionTitle } from "@/components/Layout";
import { api } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { queries } from "@/lib/queries";
import { useAction } from "@/lib/query";

/** The section's anchor; connect prompts and the extension link to it. */
export const TRACKER_ACCOUNTS_ID = "tracker-accounts";

/**
 * Starts connecting the person's own account in a tracker: the server sends the browser to the tracker to allow
 * Inklayer, then back to `returnTo` (this page by default).
 */
export function connectTrackerUrl(kind: string, returnTo = `${location.pathname}${location.search}${location.hash}`) {
  return `/api/me/tracker-accounts/${encodeURIComponent(kind)}/connect?returnTo=${encodeURIComponent(returnTo)}`;
}

/** How an account is named: @login where the tracker has logins (GitHub, GitLab, Forgejo), else as given (a name or email). */
export function accountName(kind: string, login: string): string {
  return ["github", "gitlab", "forgejo"].includes(kind) ? `@${login}` : login;
}

/** What went wrong connecting, when the tracker sent the person back with an error; removed from the address once read. */
export function useTrackerAccountError(): string | null {
  const [message] = useState(() => new URLSearchParams(location.search).get("trackerAccountError"));
  useEffect(() => {
    if (!message) return;
    const url = new URL(location.href);
    url.searchParams.delete("trackerAccountError");
    history.replaceState(history.state, "", url);
  }, [message]);
  return message;
}

/**
 * "Tracker accounts": the person's own accounts in issue trackers (GitHub), so issues, replies and closes they make from
 * Inklayer show as them. Hidden when the server has no tracker OAuth apps set up, or issue trackers are off.
 */
export function TrackerAccounts() {
  const { me } = useMe();
  const accounts = useQuery({ ...queries.trackerAccounts(), enabled: me.features.issueTrackers });
  const action = useAction();
  const failed = useTrackerAccountError();
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    if (accounts.isFetched && location.hash === `#${TRACKER_ACCOUNTS_ID}`)
      section.current?.scrollIntoView({ block: "start" });
  }, [accounts.isFetched]);

  if (!me.features.issueTrackers || !accounts.data?.length) return null;
  return (
    <section id={TRACKER_ACCOUNTS_ID} ref={section} className="scroll-mt-6">
      <SectionTitle>Tracker accounts</SectionTitle>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Connect your own accounts, and the issues you create, the replies you post to them and the issues you close from
        Inklayer show as you. <GuideLink section="your-own-tracker-account" />
      </p>
      {failed && <p className="mb-3 max-w-2xl text-sm text-destructive">{failed}</p>}
      <ErrorText error={action.error ?? accounts.error} />
      <ul className="max-w-2xl divide-y rounded-xl border">
        {accounts.data.map((a) => (
          <li key={a.kind} className="flex items-center gap-3 px-4 py-3">
            <UserRound className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{a.name}</p>
              {a.login ? (
                <p className="text-xs text-muted-foreground">
                  {a.url ? (
                    <a href={a.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {accountName(a.kind, a.login)}
                    </a>
                  ) : (
                    accountName(a.kind, a.login)
                  )}
                  {a.connectedAt && <span title={dateTime(a.connectedAt)}> · connected {timeAgo(a.connectedAt)}</span>}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Not connected</p>
              )}
            </div>
            {a.login ? (
              <ConfirmButton
                title={`Disconnect ${a.name}?`}
                description={`Inklayer stops acting as ${accountName(a.kind, a.login)}. Where a project has a shared ${a.name} account, that is used instead.`}
                confirmLabel="Disconnect"
                onConfirm={() =>
                  void action.run(() =>
                    api.delete("/api/me/tracker-accounts/{kind}", { params: { path: { kind: a.kind } } }),
                  )
                }
              >
                Disconnect
              </ConfirmButton>
            ) : (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<a href={connectTrackerUrl(a.kind, `/#${TRACKER_ACCOUNTS_ID}`)} />}
              >
                <ExternalLink data-icon="inline-start" />
                Connect {a.name}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
