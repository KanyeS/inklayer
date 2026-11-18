/** A person as the server describes them: the name they chose (or their real name), and for hover, their real name and role. */
export interface Person {
  displayName: string;
  fullName?: string | null;
  role?: string | null;
}

/** "Real Name · Role" for hover, so people who chose another name can still be recognised. */
export function personTitle(person: Person): string {
  return [person.fullName ?? person.displayName, person.role].filter(Boolean).join(" · ");
}
