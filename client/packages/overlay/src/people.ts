/**
 * How other people on a page are shown: their names, initials and colours, the pointer arrow, and the avatar pill.
 * The text helpers are pure and unit-tested in test/presence.test.ts.
 */

/** Someone else on the page. */
export interface PresencePeerView {
  id: string;
  /** The name they chose to be shown as, or their real name. */
  name: string;
  color: string;
  /** Their real name, from sign-in, shown on hover. */
  fullName?: string | null;
}

export type PresenceStatus = "connecting" | "live" | "offline";

/** Faces shown in the pill before the rest are counted as "+N". */
const MAX_FACES = 5;
const FALLBACK_COLOR = "#7c3aed";
const SVG_NS = "http://www.w3.org/2000/svg";

/** "Chosen (Real Name)" when someone chose another name, so they can still be recognised. */
export function realName(peer: PresencePeerView): string {
  return peer.fullName && peer.fullName !== peer.name ? `${peer.name} (${peer.fullName})` : peer.name;
}

/** Only #rrggbb colours reach the style attribute (colours come from other people). */
export function safeColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : FALLBACK_COLOR;
}

/** Up to two letters for an avatar: first and last word, or the first two letters of one word (or an email's name). */
export function initials(name: string): string {
  const words = (name.trim().split("@")[0] ?? "").split(/[\s._-]+/).filter(Boolean);
  const first = words[0] ?? "?";
  const last = words[words.length - 1] ?? "";
  const letters = words.length > 1 ? (first[0] ?? "") + (last[0] ?? "") : first.slice(0, 2);
  return letters.toUpperCase();
}

/** What the pill says: "Live · just you", "Live", "Connecting…", or why it's offline. */
export function statusLabel(status: PresenceStatus, othersHere: number, offlineText = ""): string {
  if (status === "live") return othersHere === 0 ? "Live · just you" : "Live";
  if (status === "connecting") return "Connecting…";
  return offlineText || "Offline";
}

function div(doc: Document, className: string): HTMLDivElement {
  const el = doc.createElement("div");
  el.className = className;
  return el;
}

/** The pointer arrow, filled with the person's colour (--c) and outlined in white. Built as DOM, not parsed. */
export function cursorArrow(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({
    width: "20",
    height: "22",
    viewBox: "0 0 20 22",
    "aria-hidden": "true",
  }))
    svg.setAttribute(name, value);
  const path = doc.createElementNS(SVG_NS, "path");
  const attributes = {
    d: "M2.5 1.8 L2.5 17.6 L6.6 13.7 L9.4 20.1 L12.4 18.8 L9.6 12.5 L15.4 12.5 Z",
    fill: "var(--c)",
    stroke: "#fff",
    "stroke-width": "1.5",
    "stroke-linejoin": "round",
  };
  for (const [name, value] of Object.entries(attributes)) path.setAttribute(name, value);
  svg.append(path);
  return svg;
}

/** Someone's cursor: the arrow and a name tag, hidden until they move. */
export function cursorElement(
  doc: Document,
  peer: PresencePeerView,
): { cursor: HTMLDivElement; label: HTMLSpanElement } {
  const cursor = div(doc, "cursor");
  cursor.style.setProperty("--c", safeColor(peer.color));
  const label = doc.createElement("span");
  label.className = "name";
  label.textContent = peer.name;
  label.title = realName(peer);
  cursor.append(cursorArrow(doc), label);
  cursor.hidden = true;
  return { cursor, label };
}

/** The pill: a status dot and text, then a face per person (click to find their cursor), then "+N". */
export function avatarPill(
  doc: Document,
  status: { status: PresenceStatus; text: string },
  peers: PresencePeerView[],
  onFace: (peer: PresencePeerView) => void,
): HTMLDivElement {
  const pill = div(doc, `pill ${status.status}`);
  const label = doc.createElement("span");
  label.className = "status";
  label.textContent = statusLabel(status.status, peers.length, status.text);
  pill.append(div(doc, "dot"), label);
  if (peers.length === 0) return pill;

  const shown = peers.slice(0, MAX_FACES);
  const faces = div(doc, "faces");
  for (const peer of shown) {
    const face = doc.createElement("button");
    face.className = "face";
    face.type = "button";
    face.title = `${realName(peer)}: show their cursor`;
    face.style.setProperty("--c", safeColor(peer.color));
    face.textContent = initials(peer.name);
    face.addEventListener("click", () => onFace(peer));
    faces.append(face);
  }
  const rest = peers.slice(shown.length);
  if (rest.length > 0) {
    const more = div(doc, "face more");
    more.textContent = `+${rest.length}`;
    more.title = rest.map((p) => p.name).join(", ");
    faces.append(more);
  }
  pill.append(faces);
  return pill;
}
