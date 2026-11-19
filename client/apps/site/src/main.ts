/**
 * The showcase page at https://inklayer.online. One module per section; each sets up its mock page and starts its demo.
 * Marks, cursors and comment cards are the extension's own code (@inklayer/overlay); see lib/stage.ts.
 */
import "./styles.css";
import outfit from "@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2?url";
import { exposeColors } from "./lib/people";
import { address } from "./sections/address";
import { anchors } from "./sections/anchors";
import { bugContext } from "./sections/bug-context";
import { docs } from "./sections/docs";
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
docs();
mcp();
