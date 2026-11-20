import { describe, expect, it } from "vitest";
import {
  CODE,
  classesDefinedIn,
  classesUsedIn,
  exists,
  filesIn,
  importsOf,
  lineCount,
  PROJECTS,
  projectOf,
  read,
  resolveRelative,
  sourceFiles,
} from "./source";

/**
 * Architecture tests: they read the client's own source and check the rules that keep it readable, so a change that
 * breaks one fails here with the file and the rule, instead of the codebase quietly drifting back.
 */

const files = sourceFiles();
const relativeImports = files.flatMap((file) =>
  importsOf(file)
    .filter((s) => s.startsWith("."))
    .map((specifier) => ({ file, specifier, target: resolveRelative(file, specifier) })),
);

/** The browser extension's content scripts: built as self-contained scripts injected into every web page. */
const CONTENT_SCRIPT = (f: string) =>
  f.startsWith("apps/extension/src/live/") ||
  [
    "apps/extension/src/live-page.ts",
    "apps/extension/src/presence-page.ts",
    "apps/extension/src/capture-main.ts",
  ].includes(f);

describe("project boundaries", () => {
  it("finds the source it checks", () => {
    for (const project of PROJECTS)
      expect(
        files.some((f) => f.startsWith(project)),
        project,
      ).toBe(true);
  });

  it("relative imports stay inside their own project", () => {
    const crossing = relativeImports
      .filter(({ file, target }) => projectOf(target) !== projectOf(file))
      .map(({ file, specifier }) => `${file} imports ${specifier}`);
    expect(crossing).toEqual([]);
  });

  it("relative imports point at files that exist", () => {
    const missing = relativeImports
      .filter(({ target }) => !exists(target))
      .map(({ file, specifier }) => `${file} imports ${specifier}`);
    expect(missing).toEqual([]);
  });

  it("shared packages never import from the apps", () => {
    const fromApps = files
      .filter((f) => f.startsWith("packages/"))
      .flatMap((f) => importsOf(f).map((s) => ({ f, s })))
      .filter(({ s }) => /^@inklayer\/(extension|viewer|site)\b/.test(s))
      .map(({ f, s }) => `${f} imports ${s}`);
    expect(fromApps).toEqual([]);
  });

  it("each project imports only the workspace packages it depends on", () => {
    const undeclared: string[] = [];
    for (const project of PROJECTS) {
      const pkg = JSON.parse(read(`${project}/package.json`)) as {
        name: string;
        dependencies?: Record<string, string>;
      };
      const declared = new Set(Object.keys(pkg.dependencies ?? {}));
      for (const file of files.filter((f) => f.startsWith(`${project}/`))) {
        for (const specifier of importsOf(file)) {
          const name = /^(@inklayer\/[^/]+)/.exec(specifier)?.[1];
          if (name && name !== pkg.name && !declared.has(name)) undeclared.push(`${file} imports ${name}`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("the overlay package uses no UI library (it runs inside other people's pages, and the viewer and site share it)", () => {
    const framework = filesIn("packages/overlay/src", CODE).filter((f) =>
      importsOf(f).some((s) => /^(react(-dom)?|preact)\b/.test(s)),
    );
    expect(framework).toEqual([]);
  });

  it("content scripts render with Preact, not React or the UI components (they're injected into every page)", () => {
    const heavy = files
      .filter(CONTENT_SCRIPT)
      .flatMap((f) => importsOf(f).map((s) => ({ f, s })))
      .filter(
        ({ s }) =>
          /^react(-dom)?\b/.test(s) ||
          // compat would let React libraries in
          /^preact\/compat\b/.test(s) ||
          /^@inklayer\/ui\/components\b/.test(s) ||
          /^lucide-react\b/.test(s),
      )
      .map(({ f, s }) => `${f} imports ${s}`);
    expect(heavy).toEqual([]);
  });

  it("content scripts' JSX compiles to Preact (without the pragma it would quietly bundle React)", () => {
    const withoutPragma = files
      .filter((f) => CONTENT_SCRIPT(f) && f.endsWith(".tsx"))
      .filter((f) => !read(f).startsWith("/** @jsxImportSource preact */"));
    expect(withoutPragma).toEqual([]);
  });
});

describe("file size", () => {
  /** Past this, a file is doing too much: split it into modules with one job each. */
  const MAX_LINES = 800;

  it(`no source file is longer than ${MAX_LINES} lines`, () => {
    const long = files.filter((f) => lineCount(f) > MAX_LINES).map((f) => `${f}: ${lineCount(f)} lines`);
    expect(long).toEqual([]);
  });
});

describe("styles live in CSS files", () => {
  /**
   * A line that is a whole CSS rule (as embedded stylesheets were written): a selector starting with . # : or @, then `{ property: value; …`. (A private class field,
   * `#name: { … }`, is not.)
   */
  const CSS_RULE_LINE = /^[ \t]*(?!#\w+[ \t]*:)[.#:@][\w-][^{}()=;\n]*\{[ \t]*[a-z-]+[ \t]*:[ \t]*[^;{}\n]+;/m;

  it("no TypeScript file embeds a stylesheet in a string", () => {
    const embedded = files.filter((f) => CSS_RULE_LINE.test(read(f)) || /<style>/.test(read(f)));
    expect(embedded).toEqual([]);
  });

  it("the check above would catch an embedded stylesheet", () => {
    expect(CSS_RULE_LINE.test("const STYLES = `\n  .panel { display: flex; gap: 4px; }\n`;")).toBe(true);
    expect(CSS_RULE_LINE.test("  :host { all: initial; }")).toBe(true);
    expect(CSS_RULE_LINE.test("  .then((x) => { y: 1; })")).toBe(false);
    expect(CSS_RULE_LINE.test("  #entry: { at: number; value: T } | null = null;")).toBe(false);
  });

  it("every `?inline` stylesheet import points at a CSS file that exists", () => {
    const missing = relativeImports
      .filter(({ specifier }) => specifier.endsWith(".css?inline"))
      .filter(({ target }) => !exists(target))
      .map(({ file, specifier }) => `${file} imports ${specifier}`);
    expect(missing).toEqual([]);
  });

  describe("the extension's live panel", () => {
    const panelCss = read("apps/extension/src/live/styles/panel.css");
    const bubblesCss = read("packages/overlay/src/styles/bubbles.css");
    const defined = new Set([...classesDefinedIn(panelCss), ...classesDefinedIn(bubblesCss)]);
    const liveCode = filesIn("apps/extension/src/live", CODE);
    // Classes can also be set by the overlay package's shared code (bubbles, followColorScheme's "dark").
    const allLiveCode = [...liveCode, ...filesIn("packages/overlay/src", CODE)].map(read).join("\n");

    it("every class the panel's views set is styled", () => {
      const unstyled = liveCode.flatMap((f) =>
        [...classesUsedIn(read(f))].filter((c) => !defined.has(c)).map((c) => `${f}: .${c}`),
      );
      expect(unstyled).toEqual([]);
    });

    it("every class in panel.css is used by the panel (no dead CSS)", () => {
      const unused = [...classesDefinedIn(panelCss)].filter((c) => !new RegExp(`\\b${c}\\b`).test(allLiveCode));
      expect(unused).toEqual([]);
    });

    it("uses the font the panel registers on the page", async () => {
      const { PANEL_FONT } = await import("../apps/extension/src/live/page-io");
      expect(panelCss).toContain(`"${PANEL_FONT}"`);
    });
  });

  it("bubble cards take their width from the TypeScript that places them", () => {
    expect(read("packages/overlay/src/styles/bubbles.css")).toContain("var(--bubble-width)");
    expect(read("packages/overlay/src/bubbles.ts")).toContain('"--bubble-width"');
  });

  it("every named class in the docs layout CSS is used (no dead CSS)", () => {
    const css = classesDefinedIn(read("apps/viewer/src/docs/layout.css"));
    const viewer = [...classesUsedIn(filesIn("apps/viewer/src", CODE).map(read).join("\n"))];
    expect(css.size).toBeGreaterThan(0);
    expect([...css].filter((c) => !viewer.includes(c))).toEqual([]);
  });
});

describe("conventions", () => {
  it("no ESLint comments are left (the project lints with Biome)", () => {
    expect(files.filter((f) => /eslint-(disable|enable)/.test(read(f)))).toEqual([]);
  });

  it("modules that say they're unit-tested have a test that imports them", () => {
    const tests = [
      ...PROJECTS.flatMap((p) => filesIn(`${p}/test`, CODE)),
      ...filesIn("test", CODE).filter((f) => f.endsWith(".test.ts")),
    ];
    const imported = new Set(
      tests.flatMap((t) =>
        importsOf(t)
          .filter((s) => s.startsWith("."))
          .map((s) => resolveRelative(t, s)),
      ),
    );
    const claimed = files.filter((f) => /unit-tested/i.test(read(f)));
    const untested = claimed.filter((f) => !imported.has(f.replace(/\.tsx?$/, "")) && !imported.has(f));
    expect(claimed.length).toBeGreaterThan(0);
    expect(untested).toEqual([]);
  });
});

describe("extension messages", () => {
  const types = read("apps/extension/src/lib/live-types.ts");
  const declared = new Set([...types.matchAll(/type:\s*"(live\.[\w]+)"/g)].map((m) => m[1]));

  it("the content script only sends requests the background declares", () => {
    const sent = files
      .filter(CONTENT_SCRIPT)
      .flatMap((f) => [...read(f).matchAll(/type:\s*"(live\.[\w]+)"/g)].map((m) => ({ f, type: m[1] ?? "" })));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter(({ type }) => !declared.has(type)).map(({ f, type }) => `${f}: ${type}`)).toEqual([]);
  });

  it("the background handles exactly the declared requests", async () => {
    const { HANDLED_REQUEST_TYPES } = await import("../apps/extension/src/lib/live");
    expect(new Set(HANDLED_REQUEST_TYPES)).toEqual(declared);
  });

  it("every declared request is sent by the content script (no dead handlers)", () => {
    const code = files.filter(CONTENT_SCRIPT).map(read).join("\n");
    expect([...declared].filter((t) => !code.includes(`"${t}"`))).toEqual([]);
  });
});
