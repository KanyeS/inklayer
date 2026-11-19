/** Where the in-page panel sits: its distance from the window's right and bottom edges, so it grows upwards from there. */
export interface PanelPosition {
  right: number;
  bottom: number;
}

export const DEFAULT_POSITION: PanelPosition = { right: 16, bottom: 16 };

/** Keeps at least this much of the window between the panel and each edge. */
const MARGIN = 8;

/** Keeps the panel fully inside the window (or as much of it as fits), e.g. after the window shrinks or the panel grows. */
export function clampPosition(
  position: PanelPosition,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): PanelPosition {
  const clamp = (value: number, max: number) => Math.round(Math.min(Math.max(value, MARGIN), Math.max(MARGIN, max)));
  return {
    right: clamp(position.right, viewport.width - size.width - MARGIN),
    bottom: clamp(position.bottom, viewport.height - size.height - MARGIN),
  };
}

/** A saved position, if it's a valid one. */
export function parsePosition(value: unknown): PanelPosition | null {
  const p = value as Partial<PanelPosition> | null;
  return p && Number.isFinite(p.right) && Number.isFinite(p.bottom) ? { right: p.right!, bottom: p.bottom! } : null;
}
