import dockCss from "./styles/recorder-dock.css?inline";

/**
 * The recorder (recorder.html, an extension page) as a small bar at the bottom of the page: Start, then Stop, Draw and
 * the time. It's kept apart from the panel, so the panel can get out of the way while the tab is recorded without
 * disturbing the recording.
 */
export class RecorderDock {
  #host: HTMLElement | null = null;
  #frame: HTMLIFrameElement | null = null;

  get isOpen(): boolean {
    return this.#host !== null;
  }

  open(): void {
    if (this.#host) return;
    const host = document.createElement("inklayer-recorder");
    host.setAttribute(
      "style",
      "all:initial;position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;",
    );
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = dockCss;
    const frame = document.createElement("iframe");
    frame.title = "Record the tab";
    frame.allow = "display-capture; autoplay";
    frame.src = chrome.runtime.getURL("recorder.html?embedded=1");
    root.append(style, frame);
    document.documentElement.append(host);
    this.#host = host;
    this.#frame = frame;
  }

  /** Removes it now: only once it isn't sharing (removing a page that's sharing crashes the Firefox snap). */
  remove(): void {
    this.#host?.remove();
    this.#host = null;
    this.#frame = null;
  }

  /** Closes it, telling it to end any share first and removing it a moment later. */
  close(): void {
    const host = this.#host;
    if (!host) return;
    this.#frame?.contentWindow?.postMessage({ type: "inklayer.recorder.stop" }, "*");
    this.#host = null;
    this.#frame = null;
    setTimeout(() => host.remove(), 1500);
  }
}
