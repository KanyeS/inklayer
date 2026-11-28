import type * as Y from "yjs";
import { addCard } from "./boardModel";

/** Pictures a board takes, and how big (the server checks too). */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface LinkPreview {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
}

/** Uploads a picture for the board. Returns its id, for the card. */
export async function uploadImage(boardId: string, file: Blob): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error("Add a PNG, JPEG, WebP or GIF picture.");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("Pictures can be at most 10 MB.");
  const response = await fetch(`/api/boards/${boardId}/media`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": file.type, "X-Inklayer-Csrf": "1" },
    body: file,
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { title?: string; detail?: string } | null;
    throw new Error(problem?.detail ?? problem?.title ?? `Upload failed (${response.status}).`);
  }
  return ((await response.json()) as { id: string }).id;
}

/** The page's title, description and picture, as the server read them (falls back to just the address). */
export async function previewLink(boardId: string, url: string): Promise<LinkPreview> {
  try {
    const response = await fetch(`/api/boards/${boardId}/link-preview?url=${encodeURIComponent(url)}`, {
      credentials: "same-origin",
    });
    if (response.ok) return (await response.json()) as LinkPreview;
  } catch {
    // the address alone will do
  }
  return { url };
}

/** The picture's size, scaled to fit a card. */
async function cardSize(file: Blob): Promise<{ w: number; h: number }> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 360 / bitmap.width, 360 / bitmap.height);
    const size = {
      w: Math.max(80, Math.round(bitmap.width * scale)),
      h: Math.max(60, Math.round(bitmap.height * scale)),
    };
    bitmap.close();
    return size;
  } catch {
    return { w: 260, h: 200 };
  }
}

export async function addImage(doc: Y.Doc, boardId: string, file: Blob, at: { x: number; y: number }): Promise<void> {
  const [mediaId, size] = await Promise.all([uploadImage(boardId, file), cardSize(file)]);
  addCard(doc, at, { type: "image", mediaId, alt: file instanceof File ? file.name : undefined, ...size });
}

export async function addLink(doc: Y.Doc, boardId: string, url: string, at: { x: number; y: number }): Promise<void> {
  const preview = await previewLink(boardId, url);
  addCard(doc, at, {
    type: "link",
    url: preview.url || url,
    title: preview.title ?? undefined,
    description: preview.description ?? undefined,
    image: preview.image ?? undefined,
  });
}

/** An http(s) address, if that's all the text is. */
export function asUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  try {
    return new URL(trimmed).href;
  } catch {
    return null;
  }
}

/**
 * Something pasted or dropped on the board: pictures become image cards, an address a link card, other text a note.
 * Cards dropped together are spread out a little.
 */
export async function pasteOrDrop(
  doc: Y.Doc,
  boardId: string,
  data: DataTransfer,
  at: { x: number; y: number },
): Promise<void> {
  const files = [...data.files].filter((f) => IMAGE_TYPES.includes(f.type));
  if (files.length) {
    await Promise.all(files.map((f, i) => addImage(doc, boardId, f, { x: at.x + i * 32, y: at.y + i * 32 })));
    return;
  }
  const text = data.getData("text/uri-list").split("\n")[0] || data.getData("text/plain");
  if (!text.trim()) return;
  const url = asUrl(text);
  if (url) await addLink(doc, boardId, url, at);
  else addCard(doc, at, { type: "note", text: text.slice(0, 5000) });
}
