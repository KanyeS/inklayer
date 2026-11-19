/**
 * Issue trackers: Rosie creates an issue from her comment; Michael closes it in the tracker, which resolves the comment
 * with a reply saying so. Each loop uses the next tracker: GitHub, Jira, Linear.
 */
import { $, $$, h, replay } from "../lib/dom";
import { MICHAEL, ROSIE } from "../lib/people";
import { scene } from "../lib/scene";
import { Stage } from "../lib/stage";

interface Tracker {
  id: string;
  name: string;
  key: string;
  open: string;
  closed: string;
  closeLabel: string;
  createdBy: string;
}

const TRACKERS: Tracker[] = [
  { id: "github", name: "GitHub", key: "#482", open: "Open", closed: "Closed", closeLabel: "Close issue", createdBy: "Rosie opened this via Inklayer" },
  { id: "jira", name: "Jira", key: "NW-118", open: "To Do", closed: "Done", closeLabel: "Move to Done", createdBy: "Reporter: Rosie · Bug · created via Inklayer" },
  { id: "linear", name: "Linear", key: "ENG-231", open: "Todo", closed: "Done", closeLabel: "Mark as Done", createdBy: "Created by Rosie via Inklayer" },
];

/** What Inklayer puts in the issue: the comment, its replies and the page details. */
const DETAILS: [string, string][] = [
  ["Page", "shop.example/checkout"],
  ["Browser", "Safari 17 · iOS 17.4"],
  ["Window", "375 × 667 @3x"],
  ["Console", "TypeError: banner.offsetHeight is undefined"],
  ["Inklayer", "Open comment #4 ↗"],
];

export function issues(): void {
  const issue = $("#issue-card");
  const create = $("#create-issue");
  const link = $("#issue-link");
  const status = $("#issue-status");
  const autoReply = $("#issue-reply");
  const comment = $("#issue-comment");
  const sync = $("#sync svg");
  const tabs = $$("#tracker-tabs span");

  const stage = new Stage($(".issue-stage"));
  const rosie = stage.person(ROSIE);
  const michael = stage.person(MICHAEL);
  let loop = 0;

  const reset = () => {
    issue.className = "card issue empty";
    issue.textContent = "No issue yet";
    create.hidden = false;
    link.hidden = true;
    autoReply.hidden = true;
    status.replaceChildren();
    comment.classList.remove("resolved");
  };
  const pill = (className: string, text: string) => h("span", { className, textContent: text });

  scene($("#issues"), async (ctx) => {
    reset();
    const tracker = TRACKERS[loop++ % TRACKERS.length]!;
    for (const tab of tabs) tab.classList.toggle("on", tab.dataset.t === tracker.id);
    await ctx.sleep(500);

    await rosie.moveTo(ctx, { el: create }, 1100);
    replay(create, "press");
    replay(sync, "pulse");
    await ctx.sleep(500);

    const state = h("span", { className: "state", textContent: tracker.open });
    const close = h("span", { className: "pbtn", textContent: tracker.closeLabel });
    issue.className = `card issue ${tracker.id}`;
    issue.replaceChildren(
      h("div", { className: "ihead" }, h("h4", {}, "Checkout button hidden behind cookie banner ", h("span", { textContent: tracker.key }))),
      h("div", { className: "imeta" }, state, ` ${tracker.createdBy}`),
      h("div", { className: "ibody" },
        h("p", { textContent: "Checkout button is hidden behind the cookie banner on iPhone SE." }),
        h("p", {}, h("b", { textContent: "Michael:" }), " On it, looks like a z-index fight."),
        h("table", {}, ...DETAILS.map(([k, v]) => h("tr", {}, h("td", { textContent: k }), h("td", { textContent: v }))))),
      h("div", { className: "row", style: { "margin-top": "12px" } }, close));
    create.hidden = true;
    link.hidden = false;
    link.textContent = `${tracker.name} ${tracker.key} ↗`;
    status.replaceChildren(pill("warn", tracker.open));
    await rosie.moveTo(ctx, { el: comment, x: 0.2, y: 1.3 }, 1200);
    await ctx.sleep(1200);

    // Closed in the tracker: Inklayer resolves the comment and says why.
    await michael.moveTo(ctx, { el: close }, 1300);
    replay(close, "press");
    state.classList.add("closed");
    state.textContent = tracker.closed;
    await ctx.sleep(400);
    replay(sync, "pulse");
    await ctx.sleep(500);
    comment.classList.add("resolved");
    status.replaceChildren(pill("ok", "Resolved"));
    autoReply.hidden = false;
    autoReply.replaceChildren(h("b", { textContent: "Inklayer" }), ` ${tracker.name} ${tracker.key} was closed, so this comment was resolved.`);
    await michael.moveTo(ctx, { el: issue, x: 0.9, y: 1.05 }, 1200);
    await ctx.sleep(3500);
  }, { gap: 400, reset });
}
