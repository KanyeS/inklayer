// Makes the Firefox build (dist-firefox/) from the Chrome build (dist/). The code is the same; only the manifest differs:
//  - Firefox runs MV3 background code as an event page (background.scripts), not a service worker.
//  - Chrome's "key" (the Web Store public key that pins the Chrome extension ID) is removed.
//  - Firefox needs a fixed add-on ID. Its sign-in address, https://<hash>.extensions.allizom.org/, is derived from it.
// Run after `vite build` (see the build script in package.json).
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const FIREFOX_ID = "inklayer-extension@inklayer";
const FIREFOX_MIN_VERSION = "128.0";

rmSync("dist-firefox", { recursive: true, force: true });
cpSync("dist", "dist-firefox", { recursive: true });

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const { service_worker: worker, ...background } = manifest.background;
manifest.background = { ...background, scripts: [worker] };
delete manifest.minimum_chrome_version;
// Chrome-only: recording from a hidden page (offscreen documents, and asking what to share with desktopCapture).
// Firefox records in a small window instead (see src/lib/recorder-session.ts).
manifest.permissions = manifest.permissions.filter((p) => p !== "offscreen");
manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => p !== "desktopCapture");
if (manifest.optional_permissions.length === 0) delete manifest.optional_permissions;
rmSync("dist-firefox/offscreen.html", { force: true });
// Firefox records in Inklayer's sidebar instead: it stays while the page changes, and the person starts it with a click
// there (Firefox only shares from a click in the page that records).
manifest.sidebar_action = {
  default_panel: "sidebar.html",
  default_title: "Inklayer recorder",
  default_icon: manifest.action.default_icon,
  open_at_install: false,
};
// Chrome-only: the Web Store public key, so unpacked Chrome builds get the store's extension ID.
delete manifest.key;
manifest.browser_specific_settings = {
  gecko: {
    id: FIREFOX_ID,
    strict_min_version: FIREFOX_MIN_VERSION,
    // addons.mozilla.org asks every add-on to declare what it transmits. Comments, with the element they're
    // attached to on the page, are sent to the Inklayer server the user connects to.
    data_collection_permissions: { required: ["websiteContent"] },
  },
};

writeFileSync("dist-firefox/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log("dist-firefox/ ready (Firefox build)");
