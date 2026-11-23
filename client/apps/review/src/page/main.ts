import { CLICKS_FLAG, showClicks } from "./clicks";
import { describe, PAGE_GLOBAL } from "./describe";

// Put into every page the review browser opens, before the page's own scripts.
Object.defineProperty(window, PAGE_GLOBAL, { value: { describe }, enumerable: false });
if ((window as unknown as Record<string, unknown>)[CLICKS_FLAG] === true) showClicks();
