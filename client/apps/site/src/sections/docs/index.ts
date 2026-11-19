/**
 * Docs: a small knowledge base with the app's own pieces. The notes sidebar and tags, a note's icon, title and tag
 * pills, the formatting toolbar and markdown cheat sheet, the real editor (packages/docs/src/editor.ts) or the
 * reading view (checkboxes, diagrams, maths…), and the link graph. On the QA note, John and Rosie edit at the same time
 * as the visitor: their carets come from the editor's collaboration plugin, their pointers from PresenceLayer.
 * Everything is in memory; nothing is saved.
 */

import type { EditorView } from "@codemirror/view";
import { addTag, extractTags, removeTag, textEdit } from "@inklayer/docs/docMarkdown";
import { createEditor } from "@inklayer/docs/editor";
import { enhance } from "@inklayer/docs/enhance";
import { applyFormat, FORMAT_GROUPS } from "@inklayer/docs/formatting";
import { renderMarkdown } from "@inklayer/docs/reading";
import { PresenceLayer } from "@inklayer/overlay";
import "@inklayer/docs/reading.css";
import { Room, type Teammate, type TextPointer } from "../../lib/collab";
import { $, h } from "../../lib/dom";
import { JOHN, ROSIE, YOU } from "../../lib/people";
import { scene, together } from "../../lib/scene";
import { onDemoPeopleSwitch } from "../../lib/stage";
import { cheatSheet } from "./cheatsheet";
import { linkGraph } from "./graph";
import { FORMAT_ICONS, icon } from "./icons";
import { COMMENT_ID, COMMENT_LABEL, MEMBERS, mentionOf, NOTES, type Note, QA_NOTES, TAG_STYLES } from "./notes";

export function docs(): void {
  const originals = new Map(NOTES.map((n) => [n.id, n.content]));
  let current: Note = NOTES[0]!;
  let mode: "edit" | "read" = "edit";
  let tagFilter: string | null = null;

  const room = new Room(YOU);
  room.setText(current.content);
  const john = room.join(JOHN);
  const rosie = room.join(ROSIE);
  const teammates = [john, rosie];

  const editor = createEditor($("#doc-editor"), room, {
    titles: () => NOTES.map((n) => ({ title: n.title, folder: n.folder })),
    people: async (query) =>
      MEMBERS.filter((m) => m.person.name.toLowerCase().startsWith(query.toLowerCase())).map((m) => ({
        id: m.id,
        displayName: m.person.name,
        fullName: m.fullName,
      })),
    person: (id) => {
      const member = MEMBERS.find((m) => m.id === id);
      return member && { displayName: member.person.name, fullName: member.fullName };
    },
    commentLabel: (id) => (id === COMMENT_ID ? COMMENT_LABEL : undefined),
    // Ctrl/⌘+click a [[link]] in the editor opens that note.
    openLink: (link) => {
      const note = NOTES.find((n) => n.title.toLowerCase() === link.target?.toLowerCase());
      if (note) open(note.id);
    },
    openComment: () => $("#issues").scrollIntoView(),
    onPointer: (pointer) => room.awareness.setLocalStateField("pointer", pointer),
  });
  const view = editor.view;
  showPointers($("#doc-edit"), room, view, teammates);

  const graph = linkGraph((id) => open(id));
  const guide = cheatSheet((format) => {
    setMode("edit");
    setTimeout(() => applyFormat(view, format), 0);
  });

  /* ---------------------------------------------------------------- notes */

  /** The open note's text lives in the editor; keep the note in step with it. */
  room.text.observe(() => {
    current.content = room.text.toString();
    refresh();
  });

  function open(id: string) {
    const next = NOTES.find((n) => n.id === id);
    if (!next || next === current) return;
    // John and Rosie only work on the QA note.
    if (current.id === "qa") {
      demo.stop();
      for (const t of teammates) t.leave();
    }
    current = next;
    room.setText(next.content);
    refresh();
  }

  function setMode(next: "edit" | "read") {
    mode = next;
    $("#doc-editor").hidden = mode !== "edit";
    $("#doc-toolbar").hidden = mode !== "edit";
    $("#doc-reading").hidden = mode !== "read";
    const button = $("#doc-mode");
    button.replaceChildren(icon(mode === "edit" ? "book-open" : "pen-line"), mode === "edit" ? "Read" : "Edit");
    refresh();
  }

  /* ---------------------------------------------------------------- drawing */

  const tagPill = (
    tag: string,
    opts: { count?: number; active?: boolean; onClick?: () => void; onRemove?: () => void } = {},
  ) => {
    const style = TAG_STYLES[tag] ?? {};
    const pill = h("span", {
      className: `tag-pill${opts.active ? " active" : ""}`,
      style: style.color ? { "--c": style.color } : {},
    });
    const name = h(
      opts.onClick ? "button" : "span",
      { className: "tag-name" },
      style.icon ? icon(style.icon) : null,
      `#${tag}`,
      opts.count ? h("small", { textContent: String(opts.count) }) : null,
    );
    if (opts.onClick) name.addEventListener("click", opts.onClick);
    pill.append(name);
    if (opts.onRemove) {
      const x = h("button", { className: "tag-x", title: `Remove #${tag}`, ariaLabel: `Remove #${tag}` }, icon("x"));
      x.addEventListener("click", opts.onRemove);
      pill.append(x);
    }
    return pill;
  };

  /** Changes the open note's text the smallest way, so it merges with anyone typing. */
  const editText = (change: (text: string) => string) => {
    const before = room.text.toString();
    const edit = textEdit(before, change(before));
    if (!edit) return;
    room.doc.transact(() => {
      room.text.delete(edit.from, edit.to - edit.from);
      room.text.insert(edit.from, edit.insert);
    });
  };

  function sidebar() {
    const side = $("#docs-side");
    const counts = new Map<string, number>();
    for (const n of NOTES) for (const t of extractTags(n.content)) counts.set(t, (counts.get(t) ?? 0) + 1);
    const noteRow = (n: Note) => {
      const row = h(
        "button",
        { className: `side-note${n === current ? " active" : ""}`, title: `${n.folder} / ${n.title}` },
        icon(n.icon, n.color),
        h("span", { textContent: n.title }),
      );
      row.addEventListener("click", () => open(n.id));
      return row;
    };
    const list = h("nav", { className: "side-notes", ariaLabel: "Notes" });
    if (tagFilter) {
      const filter = tagFilter;
      list.append(
        h(
          "div",
          { className: "side-filter" },
          h("span", { textContent: "Tagged" }),
          tagPill(filter, { active: true, onRemove: () => setFilter(null) }),
        ),
      );
      for (const n of NOTES.filter((n) => extractTags(n.content).includes(filter))) list.append(noteRow(n));
    } else {
      for (const folder of [...new Set(NOTES.map((n) => n.folder))]) {
        list.append(h("div", { className: "side-folder" }, icon("folder"), folder));
        for (const n of NOTES.filter((n) => n.folder === folder)) list.append(noteRow(n));
      }
    }
    const tags = h(
      "div",
      { className: "side-tags" },
      ...[...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([t, c]) =>
          tagPill(t, { count: c, active: t === tagFilter, onClick: () => setFilter(t === tagFilter ? null : t) }),
        ),
    );
    side.replaceChildren(h("h5", { textContent: "Northwind" }), list, h("h5", { textContent: "Tags" }), tags);
  }

  function setFilter(tag: string | null) {
    tagFilter = tag;
    sidebar();
  }

  function header() {
    $("#doc-crumbs").textContent = `Northwind / ${current.folder}`;
    $("#doc-icon").replaceChildren(icon(current.icon, current.color));
    $("#doc-icon").style.setProperty("--c", current.color);
    $("#doc-title").textContent = current.title;
    const tags = extractTags(room.text.toString());
    const add = h("button", { className: "tag-add" }, "+ Tag");
    add.addEventListener("click", () => {
      const input = h("input", { className: "tag-input", placeholder: "tag", ariaLabel: "New tag" });
      add.replaceWith(input);
      input.focus();
      const finish = (save: boolean) => {
        const tag = input.value.trim().replace(/^#+/, "").replace(/\s+/g, "-").toLowerCase();
        if (save && /^[\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*$/u.test(tag)) editText((t) => addTag(t, tag));
        else header();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
    });
    $("#doc-tags").replaceChildren(
      ...tags.map((t) => tagPill(t, { onClick: () => setFilter(t), onRemove: () => editText((x) => removeTag(x, t)) })),
      add,
    );
  }

  let readTimer = 0;
  function reading() {
    if (mode !== "read") return;
    clearTimeout(readTimer);
    readTimer = window.setTimeout(() => {
      const el = $("#doc-reading");
      el.innerHTML = renderMarkdown(room.text.toString(), {
        doc: (link) =>
          NOTES.some((n) => n.title.toLowerCase() === link.target?.toLowerCase()) ? { href: "#docs" } : null,
        person: (id) => {
          const member = MEMBERS.find((m) => m.id === id);
          return member && { displayName: member.person.name, fullName: member.fullName };
        },
        tickable: true,
      });
      void enhance(el);
    }, 120);
  }

  function refresh() {
    sidebar();
    header();
    reading();
    graph.update(NOTES, current.id);
  }

  /* ---------------------------------------------------------------- toolbar, reading view, buttons */

  $("#doc-toolbar").replaceChildren(
    ...FORMAT_GROUPS.map((group) =>
      h(
        "div",
        { className: "tb-group" },
        ...group.map(({ id, title }) => {
          const button = h("button", { type: "button", title, ariaLabel: title }, icon(FORMAT_ICONS[id]));
          button.addEventListener("mousedown", (e) => e.preventDefault());
          button.addEventListener("click", () => applyFormat(view, id));
          return button;
        }),
      ),
    ),
  );
  $("#doc-guide").replaceChildren(icon("info"));
  $("#doc-guide").addEventListener("click", () => guide.open());
  $("#doc-mode").addEventListener("click", () => setMode(mode === "edit" ? "read" : "edit"));

  // Reading view: [[links]] open notes; ticking a checkbox ticks it in the note's text.
  $("#doc-reading").addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("a.doc-wikilink, a[data-create], a.doc-tag");
    if (!a) return;
    e.preventDefault();
    if (a.dataset.tag) return setFilter(a.dataset.tag);
    const note = NOTES.find((n) => n.title.toLowerCase() === a.textContent?.toLowerCase());
    if (note) open(note.id);
  });
  $("#doc-reading").addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (!box.classList.contains("task-checkbox")) return;
    const line = Number(box.dataset.line);
    editText((text) =>
      text
        .split("\n")
        .map((l, i) => (i === line ? l.replace(/\[( |x|X)\]/, box.checked ? "[x]" : "[ ]") : l))
        .join("\n"),
    );
  });

  /* ---------------------------------------------------------------- John and Rosie on the QA note */

  const demo = scene(
    $("#docs"),
    async (ctx) => {
      await ctx.sleep(600);
      if (current.id !== "qa") return;
      await together(
        (async () => {
          john.placeAfter("## Fixes\n");
          await ctx.sleep(400);
          await john.type(
            ctx,
            "Lift the banner above the safe area and give the pay button 24 px of clearance. Tracked in [[Release checklist]].",
            24,
          );
        })(),
        (async () => {
          await ctx.sleep(1800);
          await rosie.select(ctx, "small phones");
          await ctx.sleep(1200);
          rosie.placeAfter("## Before release\n");
          await rosie.type(ctx, "- [ ] Retest on iPhone SE, Pixel 4a and a 320 px window, then ", 20);
          rosie.insert(mentionOf("Michael"));
          await rosie.type(ctx, " can ship it. #release", 18);
        })(),
      );
      await ctx.sleep(4000);
      for (const t of teammates) t.leave();
    },
    { once: true },
  );

  // Start over: every note as it was, the QA note open, and John and Rosie again.
  $("#doc-reset").addEventListener("click", () => {
    demo.stop();
    for (const t of teammates) t.leave();
    for (const n of NOTES) n.content = originals.get(n.id)!;
    current = NOTES[0]!;
    room.setText(QA_NOTES);
    tagFilter = null;
    setMode("edit");
    demo.start();
  });

  // "Demo people" off: John and Rosie step away (their carets go); the demo pauses until it's back on.
  onDemoPeopleSwitch((visible) => {
    if (!visible) for (const t of teammates) t.leave();
  });

  setMode("edit");
}

/**
 * Teammates' pointers over the editor, drawn by PresenceLayer from the `pointer` they share (a text position plus an
 * offset), the same way the viewer's DocView does it.
 */
function showPointers(card: HTMLElement, room: Room, view: EditorView, teammates: Teammate[]): void {
  card.classList.add("stage-root");
  const layer = new PresenceLayer(document, { within: card });
  layer.setStatus("live");
  layer.setPeers(
    teammates.map((t) => ({
      id: t.person.id,
      name: t.person.name,
      color: t.person.color,
      fullName: `${t.person.name} · ${t.person.role}`,
    })),
  );
  const place = () => {
    for (const [clientId, state] of room.awareness.getStates()) {
      const user = state.user as { peerId?: string } | undefined;
      const pointer = state.pointer as TextPointer | null | undefined;
      if (clientId === room.doc.clientID || !user?.peerId) continue;
      const coords = pointer ? view.coordsAtPos(Math.min(pointer.pos, view.state.doc.length)) : null;
      layer.placeAt(
        user.peerId,
        coords && pointer ? { x: coords.left + pointer.dx + scrollX, y: coords.top + pointer.dy + scrollY } : null,
      );
    }
  };
  let frame = 0;
  const placeSoon = () => {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
  };
  room.awareness.on("change", placeSoon);
  room.text.observe(placeSoon);
  addEventListener("resize", placeSoon);
  addEventListener("scroll", placeSoon, { passive: true });
  onDemoPeopleSwitch((visible) => layer.setVisible(visible));
}
