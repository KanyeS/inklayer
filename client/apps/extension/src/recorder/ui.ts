/** recorder.html's parts, shared by the bar and the window. */
export const ui = {
  action: document.getElementById("action") as HTMLButtonElement,
  draw: document.getElementById("draw") as HTMLButtonElement,
  time: document.getElementById("time") as HTMLSpanElement,
  status: document.getElementById("status") as HTMLParagraphElement,
};

export function say(text: string, error = false): void {
  ui.status.textContent = text;
  ui.status.className = error ? "error" : "";
}

/** "0:23 / 1:00". */
export function clock(seconds: number, max: number): string {
  const part = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${part(Math.max(0, Math.min(seconds, max)))} / ${part(max)}`;
}
