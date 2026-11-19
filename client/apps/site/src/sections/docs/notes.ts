/**
 * The demo knowledge base: a handful of notes that link to each other, each showing off different things docs can do
 * (checkboxes, callouts, tables, a diagram, maths, footnotes). Kept in memory; nothing is saved.
 */
import { JOHN, LEO, MICHAEL, ROSIE } from "../../lib/people";

export interface Note {
  id: string;
  title: string;
  folder: string;
  /** A Lucide icon name (see icons.ts) and colour, as chosen in the app's icon picker. */
  icon: string;
  color: string;
  content: string;
}

/** The team as the editor's @ suggestions see them: mentions are stored as <@id>. */
export const MEMBERS = [
  { id: "0d4e6c2a-1f3b-4a5c-9e7d-2b8f6a1c3e50", person: JOHN, fullName: "John · Design" },
  { id: "1e5f7d3b-2a4c-4b6d-8f8e-3c9a7b2d4f61", person: MICHAEL, fullName: "Michael · Dev" },
  { id: "2f6a8e4c-3b5d-4c7e-9a9f-4daa8c3e5a72", person: ROSIE, fullName: "Rosie · QA" },
  { id: "3a7b9f5d-4c6e-4d8f-8bab-5ebb9d4f6b83", person: LEO, fullName: "Leo · PM" },
];
export const mentionOf = (name: string) => `<@${MEMBERS.find((m) => m.person.name === name)!.id}>`;

/** Rosie's page comment from the issue and Claude sections, linked into the notes. */
export const COMMENT_ID = "9c1d2e3f-4a5b-4c6d-8e7f-a0b1c2d3e4f5";
export const COMMENT_LABEL = "Rosie: Checkout button is hidden behind the cookie banner on iPhone SE.";

/** How tags look, as set for the whole organisation in the app. Tags without a style use the defaults. */
export const TAG_STYLES: Record<string, { icon?: string; color?: string }> = {
  checkout: { icon: "shopping-cart", color: "#2563eb" },
  mobile: { icon: "smartphone", color: "#0891b2" },
  release: { icon: "rocket", color: "#ea580c" },
  design: { color: "#db2777" },
};

/** The note John and Rosie edit live. Its title isn't in the text, as in the app. */
export const QA_NOTES = `Release blocker: the pay button sits under the cookie banner on small phones. See [[Cookie banner]] and [[comment:${COMMENT_ID}]].

#checkout #mobile

## Fixes

## Before release
`;

export const NOTES: Note[] = [
  { id: "qa", title: "Checkout redesign: QA notes", folder: "QA", icon: "clipboard-check", color: "#7c3aed", content: QA_NOTES },
  {
    id: "banner", title: "Cookie banner", folder: "QA", icon: "cookie", color: "#e8a100",
    content: `> [!bug] Covers the pay button
> On screens under 700 px tall the banner sits on top of **Place order**.

It's \`position: fixed\` with \`z-index: 1000\`. Fix tracked in [[Checkout redesign: QA notes]].

| Device | Height | Covered? |
| --- | --- | --- |
| iPhone SE | 667 px | Yes |
| Pixel 4a | 732 px | Partly |
| iPad | 1180 px | No |

#checkout #mobile`,
  },
  {
    id: "spec", title: "Checkout spec", folder: "Product", icon: "shopping-cart", color: "#2563eb",
    content: `How an order goes through. Look and feel in [[Design system]]; card payments in [[Payment providers]].

\`\`\`mermaid
flowchart LR
  A[Cart] --> B[Details]
  B --> C{Pay}
  C -- Card --> D[Payment provider]
  C -- Wallet --> D
  D --> E[Order placed]
\`\`\`

The total is ==always worked out on the server==, never trusted from the browser.

#checkout`,
  },
  {
    id: "release", title: "Release checklist", folder: "Product", icon: "list-checks", color: "#16a34a",
    content: `> [!warning] Before Friday
> Nothing ships until every box is ticked.

- [x] Fix the [[Cookie banner]] on small phones
- [x] Totals update when a coupon is removed
- [ ] Retest on iPhone SE and Pixel 4a
- [ ] ${mentionOf("Michael")} signs off :rocket:

Switch to **Read** to tick them off.

#release #checkout`,
  },
  {
    id: "payments", title: "Payment providers", folder: "Product", icon: "credit-card", color: "#0891b2",
    content: `We charge through one provider, with a fallback.[^1]

| Provider | Fee | Payout |
| --- | --- | --- |
| Primary | 1.75% + 30c | Next day |
| Fallback | 2.9% + 30c | 2 days |

The fee on an order of $t$ cents is $f(t) = 0.0175\\,t + 30$, so a $10 order costs:

$$
f(1000) = 47.5\\text{ cents}
$$

[^1]: The fallback only takes over if the primary is down for more than five minutes.

#checkout`,
  },
  {
    id: "design", title: "Design system", folder: "Design", icon: "palette", color: "#db2777",
    content: `Buttons, colours and type for the shop. Used by [[Checkout spec]].

\`\`\`css
.button-primary {
  background: var(--primary);
  border-radius: 999px;
}
\`\`\`

> [!tip] Contrast
> Text on violet needs at least 4.5:1. Check it before shipping.

#design`,
  },
];
