import { anchorFor } from "@inklayer/overlay";
import { afterEach, describe, expect, it } from "vitest";
import { capPage } from "../src/lib/claude-helper";
import { pageForImprove } from "../src/live/improve-context";

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.title = "";
});

function portfolio() {
  document.head.innerHTML = `<meta name="description" content="Games and web apps">`;
  document.title = "Kane: Portfolio";
  document.body.innerHTML = `
    <header><h1>Welcome to My Portfolio!</h1>
      <p id="intro">I'm Kane, a developer who likes making things.   Scroll down to see more.</p></header>
    <main><h2>Projects</h2><form><input name="email" value="me@example.com"><button id="go" aria-label="Send">→</button></form></main>`;
}

describe("Improve's page context", () => {
  it("gives the page's title, description and headings, and the element with the section it's in", () => {
    portfolio();
    const intro = document.getElementById("intro") as Element;
    const page = pageForImprove(anchorFor(intro));
    expect(page).toMatchObject({
      title: "Kane: Portfolio",
      description: "Games and web apps",
      outline: ["Welcome to My Portfolio!", "Projects"],
      element: { tag: "p", text: "I'm Kane, a developer who likes making things. Scroll down to see more." },
    });
    expect(page.section).toBe(
      "Welcome to My Portfolio! I'm Kane, a developer who likes making things. Scroll down to see more.",
    );
    expect(page.element?.selector).toBe(anchorFor(intro).element.path.join(" >>> "));
  });

  it("names a control by its label, and leaves what's typed into forms out", () => {
    portfolio();
    const page = pageForImprove(anchorFor(document.getElementById("go") as Element));
    expect(page.element?.label).toBe("Send");
    expect(page.element?.html).not.toContain("me@example.com");
  });

  it("includes highlighted text, and works without an element (the page alone)", () => {
    portfolio();
    const intro = document.getElementById("intro") as Element;
    const range = document.createRange();
    range.selectNodeContents(intro);
    expect(pageForImprove(anchorFor(intro, range)).quote).toContain("likes making things");
    expect(pageForImprove(null)).toEqual({
      title: "Kane: Portfolio",
      description: "Games and web apps",
      outline: ["Welcome to My Portfolio!", "Projects"],
    });
  });

  it("is capped field by field before it goes to the helper", () => {
    const capped = capPage({
      title: "t".repeat(1000),
      outline: Array.from({ length: 100 }, () => "h".repeat(500)),
      section: "s".repeat(10_000),
      element: { tag: "p", selector: "p", text: "x".repeat(10_000), html: "<p>".repeat(5000) },
    });
    expect(capped?.title).toHaveLength(300);
    expect(capped?.outline).toHaveLength(40);
    expect(capped?.outline?.[0]).toHaveLength(200);
    expect(capped?.section).toHaveLength(4000);
    expect(capped?.element?.text).toHaveLength(3000);
    expect(capped?.element?.html).toHaveLength(3000);
    expect(capPage(undefined)).toBeUndefined();
  });
});
