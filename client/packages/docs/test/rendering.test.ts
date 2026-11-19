import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/reading";

const render = (text: string, tickable = false) => renderMarkdown(text, { doc: () => null, tickable });

describe("reading view: markdown beyond the basics", () => {
  it("checkboxes, ticked or not, with their source line; only tickable for editors", () => {
    const html = render("Intro\n\n- [ ] Retest\n- [x] Fix the banner\n- not a task", true);
    expect(html).toContain('<input type="checkbox" class="task-checkbox" data-line="2" aria-label="To do"> Retest');
    expect(html).toContain('data-line="3" checked aria-label="Done"> Fix the banner');
    expect(html).toContain("<li>not a task</li>");
    expect(render("- [ ] Retest")).toContain(" disabled ");
  });

  it("callouts, with a title or their kind as one", () => {
    const html = render(
      "> [!warning] Before release\n> Check Safari.\n\n> [!tip]\n> Use Ctrl+K.\n\n> [!nonsense] Just a quote",
    );
    expect(html).toContain(
      '<blockquote class="callout callout-warning">\n<div class="callout-title" data-kind="warning">Before release</div>',
    );
    expect(html).toContain("<p>Check Safari.</p>");
    expect(html).toContain('<div class="callout-title" data-kind="tip">Tip</div>');
    expect(html).toContain("<blockquote>\n<p>[!nonsense] Just a quote</p>");
  });

  it("maths, inline and in blocks, but not prices", () => {
    expect(render("Area is $\\pi r^2$ here.")).toContain('<span class="math math-inline" data-tex="\\pi r^2">');
    expect(render("$$\nE = mc^2\n$$")).toContain('<div class="math math-block" data-tex="E = mc^2">');
    expect(render("It costs $5 and $10.")).not.toContain("math");
  });

  it("mermaid blocks become diagrams; other code keeps its language for highlighting", () => {
    expect(render("```mermaid\ngraph TD; A-->B\n```")).toContain(
      '<div class="mermaid-diagram" data-source="graph TD; A--&gt;B\n">',
    );
    expect(render("```ts\nconst a = 1;\n```")).toContain('<code class="language-ts">');
  });

  it("highlights, footnotes and emoji", () => {
    expect(render("==important==")).toContain("<mark>important</mark>");
    const notes = render("Checked on Safari.[^1]\n\n[^1]: Version 17.");
    expect(notes).toContain('class="footnote-ref"');
    expect(notes).toContain("Version 17.");
    expect(render("Ship it :rocket:")).toContain("🚀");
  });

  it("stays safe: nothing in diagrams, maths or callout titles becomes HTML", () => {
    const html = render(
      '```mermaid\ngraph TD; A["<img src=x onerror=alert(1)>"]\n```\n\n$<script>$\n\n> [!note] <b onclick=x>t</b>',
    );
    expect(html).not.toMatch(/<img|<script|<b /);
  });
});
