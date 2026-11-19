/** The pretend team on the showcase page. Their colours are the extension's mark colours. */

export interface Person {
  id: string;
  name: string;
  role: string;
  color: string;
}

export const JOHN: Person = { id: "john", name: "John", role: "Design", color: "#f59e0b" };
export const MICHAEL: Person = { id: "michael", name: "Michael", role: "Dev", color: "#3b82f6" };
export const ROSIE: Person = { id: "rosie", name: "Rosie", role: "QA", color: "#ef4444" };
export const LEO: Person = { id: "leo", name: "Leo", role: "PM", color: "#10b981" };

/** The visitor, when they try the tools themselves. */
export const YOU: Person = { id: "you", name: "You", role: "", color: "#8b5cf6" };

export const TEAM: readonly Person[] = [JOHN, MICHAEL, ROSIE, LEO];

/** Makes `var(--john)` etc. available to the page's CSS, so colours are defined once. */
export function exposeColors(root: HTMLElement = document.documentElement): void {
  for (const person of [...TEAM, YOU]) root.style.setProperty(`--${person.id}`, person.color);
}
