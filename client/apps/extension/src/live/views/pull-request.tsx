/** @jsxImportSource preact */
import { openOnPageUrl } from "@inklayer/overlay";
import type { ComponentChild } from "preact";
import type { PullRequestPage } from "../../lib/live";

const TRACKERS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  forgejo: "Forgejo",
  azuredevops: "Azure DevOps",
  jira: "Jira",
  linear: "Linear",
};

/** Where a comment is: the page's host and path. */
function shortPage(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

/**
 * On a pull request's page: the Inklayer comments linked to it, each opening where it was left (on its page, in a new
 * tab), with its own issues.
 */
export function pullRequestBox(pr: PullRequestPage, serverUrl: string): ComponentChild {
  const open = pr.comments.filter((c) => c.status === "Open").length;
  return (
    <section className="pull-request" aria-label="Comments linked to this pull request">
      <h3>
        Linked to {TRACKERS[pr.kind] ?? pr.kind} {pr.key}
        <span className="muted">
          {" "}
          · {open} open of {pr.comments.length}
          {pr.state === "merged" ? " · merged" : pr.state === "closed" ? " · closed" : ""}
        </span>
      </h3>
      <ul>
        {pr.comments.map((c) => (
          <li key={c.id} className={c.status === "Resolved" ? "resolved" : undefined}>
            <a
              href={openOnPageUrl(c.pageUrl, c.id)}
              target="_blank"
              rel="noopener noreferrer"
              title="Open the comment where it was left"
            >
              <span className="state">{c.status === "Resolved" ? "✓" : "●"}</span>{" "}
              {c.body.split("\n")[0] || "(no text)"}
            </a>
            <p className="muted">
              {c.authorName} · {c.projectName} · {shortPage(c.pageUrl)} ·{" "}
              <a href={`${serverUrl}/comments/${c.id}`} target="_blank" rel="noopener noreferrer">
                In Inklayer
              </a>
              {c.issues.map((i) => (
                <span key={i.id}>
                  {" · "}
                  <a href={i.url} target="_blank" rel="noopener noreferrer">
                    {TRACKERS[i.kind] ?? i.kind} {i.key}
                  </a>
                </span>
              ))}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
