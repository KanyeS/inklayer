import { copyText } from "@inklayer/overlay";
import type { LiveProject } from "../lib/live";
import { call } from "./call";
import type { SharedLink } from "./views/chrome";

/** "Share this page": a read-only link to this page's comments in `target`, copied to the clipboard if allowed. */
export async function sharePage(target: LiveProject): Promise<SharedLink> {
  const { url, existing, expiresAt } = await call<{ url: string; existing: boolean; expiresAt: string | null }>({
    type: "live.share",
    projectId: target.id,
    url: location.href,
  });
  return { url, existing, expiresAt, projectName: target.name, copied: await copyText(url) };
}
