/** The Lucide icons the docs demo draws (the app picks from all of Lucide; the demo only needs these). */

import type { FormatId } from "@inklayer/docs/formatting";
import {
  AtSign,
  Bold,
  BookOpen,
  ClipboardCheck,
  Code,
  Cookie,
  Copy,
  CornerDownLeft,
  CreditCard,
  createElement,
  FileSymlink,
  FileText,
  Folder,
  Hash,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  type IconNode,
  Info,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  ListTodo,
  MessageSquare,
  MessageSquareWarning,
  Minus,
  Palette,
  PenLine,
  Rocket,
  ShoppingCart,
  Sigma,
  Smartphone,
  SquareCode,
  Strikethrough,
  Superscript,
  Table,
  TextQuote,
  Workflow,
  X,
} from "lucide";

const BY_NAME: Record<string, IconNode> = {
  "at-sign": AtSign,
  "book-open": BookOpen,
  "clipboard-check": ClipboardCheck,
  cookie: Cookie,
  copy: Copy,
  "corner-down-left": CornerDownLeft,
  "credit-card": CreditCard,
  "file-text": FileText,
  folder: Folder,
  hash: Hash,
  info: Info,
  "list-checks": ListChecks,
  "message-square": MessageSquare,
  palette: Palette,
  "pen-line": PenLine,
  rocket: Rocket,
  "shopping-cart": ShoppingCart,
  smartphone: Smartphone,
  x: X,
};

/** Each formatting action's icon, as in the app's toolbar. */
export const FORMAT_ICONS: Record<FormatId, IconNode> = {
  bold: Bold,
  italic: Italic,
  strike: Strikethrough,
  highlight: Highlighter,
  code: Code,
  link: Link,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  task: ListTodo,
  bullet: List,
  numbered: ListOrdered,
  quote: TextQuote,
  callout: MessageSquareWarning,
  table: Table,
  codeblock: SquareCode,
  mermaid: Workflow,
  math: Sigma,
  footnote: Superscript,
  divider: Minus,
  doclink: FileSymlink,
  tag: Hash,
  mention: AtSign,
};

/** An icon by name (or drawing), optionally coloured. */
export function icon(name: string | IconNode, color?: string): SVGElement {
  const node = typeof name === "string" ? (BY_NAME[name] ?? FileText) : name;
  const el = createElement(node);
  if (color) el.style.color = color;
  return el;
}

/** The icon's drawing, for placing inside the graph's SVG. */
export function iconNode(name: string): IconNode {
  return BY_NAME[name] ?? FileText;
}
