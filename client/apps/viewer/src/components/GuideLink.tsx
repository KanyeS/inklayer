import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

/** The step-by-step setup guide for integrations, in the repository's docs. */
const GUIDE = "https://github.com/KanyeS/inklayer/blob/main/docs/integrations.md";

/** Sections of the guide; each is a heading anchor in docs/integrations.md. */
export type GuideSection =
  | "issue-trackers"
  | "github"
  | "gitlab"
  | "codeberg-forgejo-and-gitea"
  | "jira-cloud"
  | "linear"
  | "azure-devops"
  | "notifications"
  | "email"
  | "slack"
  | "webhooks"
  | "ai-assistants-mcp";

/** Opens a section of the integrations setup guide in a new tab. */
export function GuideLink({ section, children = "Setup guide" }: { section: GuideSection; children?: ReactNode }) {
  return (
    <a
      href={`${GUIDE}#${section}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline dark:text-violet-300"
    >
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}
