import { startBar } from "./bar";
import { startWindow } from "./window";

/**
 * recorder.html: the bar at the bottom of the page (embedded), a remote control for the tab's recording; or the small
 * window the recording is made in, where the browser can't record from a hidden page (see lib/recorder-session.ts).
 */
const params = new URLSearchParams(location.search);
if (params.has("embedded")) startBar(params.has("choose"));
else startWindow(Number(params.get("tab")));
