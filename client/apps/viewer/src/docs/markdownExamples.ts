/**
 * The markdown cheat sheet's examples, shared by the viewer's cheat sheet (MarkdownGuide.tsx) and the showcase site's.
 * Plain data: what to type, notes, and which formatting action (formatting.ts) inserts it.
 */
import type { FormatId } from "./formatting";

export interface MarkdownExample {
  label: string;
  /** What to type. Copied as is, unless `copy` is false (things you don't type, like a mention picked from a list). */
  snippet: string;
  copy?: boolean;
  /** HTML shown instead of rendering the snippet, where a rendered example wouldn't help (our own, never user text). */
  preview?: string;
  note?: string;
  /** What Insert does to the editor's selection (see formatting.ts). */
  format?: FormatId;
}

/**
 * Everything docs understand. Previews are drawn by the reading view's own renderer (reading.ts), so they show exactly
 * what a doc will look like. Only what renders is listed.
 */
export const MARKDOWN_EXAMPLES: { title: string; examples: MarkdownExample[] }[] = [
  {
    title: "Text",
    examples: [
      { label: "Bold", snippet: "**bold**", format: "bold" },
      { label: "Italic", snippet: "*italic*", format: "italic" },
      { label: "Bold and italic", snippet: "***both***" },
      { label: "Strikethrough", snippet: "~~no longer true~~", format: "strike" },
      { label: "Highlight", snippet: "==the important bit==", format: "highlight" },
      { label: "Inline code", snippet: "`npm run build`", format: "code" },
    ],
  },
  {
    title: "Headings",
    examples: [
      { label: "Heading 1", snippet: "# Release plan", format: "h1" },
      { label: "Heading 2", snippet: "## Before launch", format: "h2" },
      { label: "Heading 3", snippet: "### Checks", format: "h3" },
    ],
  },
  {
    title: "Checkboxes, lists and callouts",
    examples: [
      { label: "Checkboxes", snippet: "- [ ] Retest on Safari\n- [x] Fix the banner", format: "task", note: "Insert puts a checkbox before every selected line. Tick them in the reading view." },
      { label: "Bulleted list", snippet: "- Checkout\n- Cart\n  - Nested: indent two spaces", format: "bullet" },
      { label: "Numbered list", snippet: "1. Reproduce\n2. Fix\n3. Retest", format: "numbered" },
      { label: "Quote", snippet: "> Works on my machine.", format: "quote" },
      { label: "Callout", snippet: "> [!warning] Before release\n> Check Safari and Firefox.", format: "callout",
        note: "Kinds: note, tip, success, question, warning, danger, bug, example, quote, important." },
      { label: "Divider", snippet: "---", format: "divider" },
    ],
  },
  {
    title: "Links, images, tables and code",
    examples: [
      { label: "Link", snippet: "[Inklayer](https://inklayer.online)", format: "link" },
      { label: "Bare address", snippet: "https://inklayer.online", note: "Becomes a link by itself." },
      { label: "Image", snippet: "![Checkout on iPhone SE](https://example.com/checkout.png)", preview: '<span class="muted">Shows the image (https addresses only).</span>' },
      { label: "Table", snippet: "| Page | Status |\n| --- | --- |\n| Checkout | Fixed |\n| Cart | Open |", format: "table",
        note: "Select lines split by commas or tabs (say, pasted from a spreadsheet) and Insert turns them into a table." },
      { label: "Code block", snippet: "```js\nconst total = items.reduce((sum, i) => sum + i.price, 0);\n```", format: "codeblock", note: "Name the language after ``` for colours." },
    ],
  },
  {
    title: "Diagrams, maths and more",
    examples: [
      { label: "Diagram", snippet: "```mermaid\nflowchart LR\n  A[Report] --> B{Can reproduce?}\n  B -- Yes --> C[Fix]\n  B -- No --> D[Ask]\n```", format: "mermaid",
        note: "Flowcharts, sequence diagrams, Gantt charts and more: mermaid.js.org" },
      { label: "Maths", snippet: "$E = mc^2$", format: "math" },
      { label: "Maths block", snippet: "$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$" },
      { label: "Footnote", snippet: "Tested on Safari.[^1]\n\n[^1]: Version 17, on an iPhone SE.", format: "footnote" },
      { label: "Emoji", snippet: ":rocket: :white_check_mark: :warning:" },
    ],
  },
  {
    title: "Inklayer",
    examples: [
      { label: "Link a doc", snippet: "[[Roadmap]]", format: "doclink", note: "Type [[ for suggestions. A doc that doesn't exist yet can be created from the link." },
      { label: "In a folder", snippet: "[[Planning/Roadmap]]" },
      { label: "To a heading", snippet: "[[Roadmap#Before launch]]" },
      { label: "With your own text", snippet: "[[Roadmap|the plan]]" },
      { label: "Tag", snippet: "#launch", format: "tag", note: "No space after #, or it's a heading." },
      { label: "Mention someone", snippet: "Type @ and pick a person", copy: false, format: "mention", preview: '<span class="doc-mention">@Alex</span>', note: "They're notified." },
      { label: "Page comment", snippet: "Paste a link to a page comment", copy: false, preview: '<span class="muted">Shows the comment as a card, kept up to date.</span>', note: "Stored as [[comment:…]]." },
    ],
  },
];
