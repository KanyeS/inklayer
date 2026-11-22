import { describe, PAGE_GLOBAL } from "./describe";

// Put into every page the review browser opens, before the page's own scripts.
Object.defineProperty(window, PAGE_GLOBAL, { value: { describe }, enumerable: false });
