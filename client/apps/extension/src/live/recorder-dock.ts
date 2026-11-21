import dockCss from "./styles/recorder-dock.css?inline";

/**
 * The recorder's bar at the bottom of the page (recorder.html, an extension page): Start, then Stop, Draw and the time.
 * It's only a remote control: the recording is made outside the page (see lib/recorder-session.ts), so the bar can go
 * at any time, and each page the tab goes to shows a new one. It's kept apart from the panel, so the panel can get out
 * of the way while the tab is recorded.
 */
export class RecorderDock {
  #host: HTMLElement | null = null;

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
  }

  remove(): void {
    this.#host?.remove();
    this.#host = null;
  }
}
