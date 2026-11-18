import { JSDOM } from "jsdom";

export function page(html: string, url = "https://shop.example/products/item.html"): Document {
  return new JSDOM(html, { url, pretendToBeVisual: true }).window.document;
}

export const NONCE = "testnonce1";
export const token = (n: number) => `ilr-${NONCE}-${n}`;
