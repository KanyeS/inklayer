import { h, lineIcon, shadowTokens } from "@inklayer/overlay";
import tokens from "@inklayer/ui/tokens.css?inline";
import type { Comment } from "./marks";
import cardCss from "./styles/cards.css?inline";

/** The demo's comment cards beside their marks, laid out like the extension's bubbles. */

/** The theme's tokens inside the cards' shadow root (as the extension's panel does), plus the few classes the cards use. */
export const CARD_STYLES = `${shadowTokens(tokens)}\n${cardCss}`;

/** Lucide's pushpin, as the extension's bubbles use. */
const PIN_PATHS = [
  "M12 17v5",
  "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
];

/** A card's content: author and time (and a pin to keep it open), the comment, then replies. */
export function commentCard(c: Comment, pinned: boolean, onPin: (pinned: boolean) => void): Node[] {
  const pin = h(
    "button",
    {
      className: pinned ? "pin-toggle on" : "pin-toggle",
      title: pinned ? "Unpin: show only on hover" : "Pin: keep this open",
      onclick: () => onPin(!pinned),
    },
    lineIcon(PIN_PATHS),
  );
  const head = h(
    "div",
    { className: "bubble-head" },
    h("span", { className: "dot", style: { background: c.person.color } }),
    h("strong", { textContent: c.person.name, title: c.person.role }),
    h("span", { className: "muted", textContent: c.time }),
    c.resolved && h("span", { className: "muted", textContent: "· resolved" }),
    h("span", { className: "grow" }),
    pin,
  );
  const nodes: Node[] = [head, h("p", { className: "body", textContent: c.body || "…" })];
  if (c.replies.length === 0) return nodes;
  const replies = c.replies.map((r) =>
    h(
      "li",
      { className: "reply" },
      h(
        "div",
        { className: "meta" },
        h("strong", { textContent: r.person.name }),
        h("span", { className: "muted", textContent: ` ${r.time}` }),
      ),
      h("span", { textContent: r.body }),
    ),
  );
  nodes.push(h("ul", { className: "replies" }, ...replies));
  return nodes;
}
