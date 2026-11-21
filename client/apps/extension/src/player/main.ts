import { apiBytes } from "../lib/api";

/**
 * A comment's recording, played on the page it's about: the live panel shows this extension page in a frame, so the
 * page's content policy can't block the video, and the page can't read it. It downloads the recording with the
 * signed-in person's access (the server checks they can see the comment) and plays it from memory.
 */

const status = document.getElementById("status") as HTMLParagraphElement;
const id = new URLSearchParams(location.search).get("id") ?? "";

async function play(): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    status.textContent = "No recording.";
    return;
  }
  try {
    const video = await apiBytes(`/api/annotations/${encodeURIComponent(id)}/media/video`);
    if (!video) {
      status.textContent = "This comment has no recording.";
      return;
    }
    const player = document.createElement("video");
    player.controls = true;
    player.autoplay = true;
    player.src = URL.createObjectURL(new Blob([video.bytes], { type: video.type }));
    status.replaceWith(player);
  } catch (e) {
    status.textContent = `The recording couldn't be loaded: ${e instanceof Error ? e.message : String(e)}`;
  }
}

void play();
