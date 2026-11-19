/**
 * The showcase page at https://inklayer.online. One module per section; each sets up its mock page and starts its demo.
 * Marks, cursors and comment cards are the extension's own code (@inklayer/overlay); see lib/stage.ts.
 */
import "./styles.css";
import outfit from "@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2?url";
import {
  ArrowLeftRight, Bell, Bug, CircleX, FileCheck, Hash, Keyboard, Link, Lock, LogIn, Mail, MessagesSquare, MousePointerClick, RefreshCw, RotateCcw, Shield, Star, Webhook,
  createIcons,
} from "lucide";
import { exposeColors } from "./lib/people";
import { address } from "./sections/address";
import { anchors } from "./sections/anchors";
import { bugContext } from "./sections/bug-context";
import { hero } from "./sections/hero";
import { history } from "./sections/history";
import { issues } from "./sections/issues";
import { mcp } from "./sections/mcp";
import { setUpPage } from "./sections/page";
import { presence } from "./sections/presence";
import { share } from "./sections/share";
import { threads } from "./sections/threads";
import { tools } from "./sections/tools";

// The overlay's badges and cards use the extension's font name for Outfit.
void new FontFace("Inklayer Outfit", `url(${outfit})`, { weight: "100 900", display: "swap" }).load().then((face) => document.fonts.add(face));

// Icons: Lucide, the set the shadcn components use. Each `<i data-lucide="name">` in the page becomes its SVG.
createIcons({
  icons: { ArrowLeftRight, Bell, Bug, CircleX, FileCheck, Hash, Keyboard, Link, Lock, LogIn, Mail, MessagesSquare, MousePointerClick, RefreshCw, RotateCcw, Shield, Star, Webhook },
});

exposeColors();
setUpPage();
hero();
tools();
anchors();
presence();
bugContext();
address();
threads();
issues();
history();
share();
// The doc editor (CodeMirror, Yjs and markdown) is most of the page's code: fetch it only as the section comes near.
whenNear("#docs", () => import("./sections/docs/index").then(({ docs }) => docs()));
mcp();

/** Runs `load` once, when the element is within about a screen of the viewport. */
function whenNear(selector: string, load: () => Promise<unknown>): void {
  const el = document.querySelector(selector);
  if (!el) return;
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    observer.disconnect();
    void load();
  }, { rootMargin: "100% 0px" });
  observer.observe(el);
}
