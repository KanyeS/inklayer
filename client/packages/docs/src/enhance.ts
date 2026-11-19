/**
 * Finishes a rendered doc (from reading.ts): draws $maths$ with KaTeX, mermaid diagrams, and colours code. Each library
 * is loaded only when a doc first needs it, so docs without them cost nothing.
 *
 * Safety: KaTeX runs with trust off (no \href, \url or HTML); mermaid runs in its strict security mode, which escapes
 * labels and sanitises the SVG it makes; highlight.js only wraps text it has escaped.
 */

/** Diagrams already drawn, by theme and source, so re-rendering a doc as someone types doesn't redraw them. */
const diagrams = new Map<string, string>();
let diagramCount = 0;

export async function enhance(root: HTMLElement): Promise<void> {
  await Promise.all([maths(root), mermaid(root), code(root)]);
}

const isDark = () => document.documentElement.classList.contains("dark");

async function maths(root: HTMLElement): Promise<void> {
  const elements = root.querySelectorAll<HTMLElement>(".math[data-tex]:not([data-done])");
  if (elements.length === 0) return;
  const [{ default: katex }] = await Promise.all([import("katex"), import("katex/dist/katex.min.css")]);
  for (const el of elements) {
    katex.render(el.dataset.tex ?? "", el, {
      displayMode: el.classList.contains("math-block"),
      throwOnError: false,
      trust: false,
      strict: "ignore",
    });
    el.dataset.done = "";
  }
}

async function mermaid(root: HTMLElement): Promise<void> {
  const elements = root.querySelectorAll<HTMLElement>(".mermaid-diagram[data-source]:not([data-done])");
  if (elements.length === 0) return;
  const { default: mermaid } = await import("mermaid");
  const theme = isDark() ? "dark" : "default";
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: "inherit" });
  for (const el of elements) {
    const source = el.dataset.source ?? "";
    const key = `${theme}\n${source}`;
    try {
      let svg = diagrams.get(key);
      if (!svg) {
        svg = (await mermaid.render(`doc-diagram-${++diagramCount}`, source)).svg;
        diagrams.set(key, svg);
      }
      el.innerHTML = svg;
      el.dataset.done = "";
    } catch (e) {
      // Leave the diagram's text showing, with why it couldn't be drawn.
      const note = document.createElement("p");
      note.className = "mermaid-error";
      note.textContent = `Couldn't draw this diagram: ${(e as Error).message.split("\n")[0]}`;
      el.querySelector(".mermaid-error")?.remove();
      el.append(note);
      el.dataset.done = "";
    }
  }
}

async function code(root: HTMLElement): Promise<void> {
  const elements = root.querySelectorAll<HTMLElement>("pre code[class*='language-']:not([data-highlighted])");
  if (elements.length === 0) return;
  const { default: hljs } = await import("highlight.js/lib/common");
  for (const el of elements) {
    const language = /language-([\w+#-]+)/.exec(el.className)?.[1];
    if (language && hljs.getLanguage(language)) hljs.highlightElement(el);
  }
}
