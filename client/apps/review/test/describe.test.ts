import { resolveElement } from "@inklayer/overlay";
import { describe, expect, it } from "vitest";
import { describe as describeElement } from "../src/page/describe";

describe("describing an element in the page", () => {
  it("anchors it as the extension would, so the comment finds it again", () => {
    document.body.innerHTML = `<main><form id="settings"><input name="email" value="me@example.com"><button>Save</button></form></main>`;
    const button = document.querySelector("button") as Element;
    const described = describeElement(button);
    expect(resolveElement(document, described.anchor.element).element).toBe(button);
    expect(described.selector).toBe(described.anchor.element.path.join(" >>> "));
    expect(described.viewport).toEqual({ width: innerWidth, height: innerHeight });
    expect(described.utcOffsetMinutes).toBe(-new Date().getTimezoneOffset());
  });

  it("leaves typed values out of the element's HTML", () => {
    document.body.innerHTML = `<form><input name="email" value="me@example.com"></form>`;
    expect(describeElement(document.querySelector("form") as Element).elementHtml).not.toContain("me@example.com");
  });
});
