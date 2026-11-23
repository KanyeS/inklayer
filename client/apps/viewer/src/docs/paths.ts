/** Addresses in the docs area. No imports, so pure modules (the graph, the sidebar) can use them. */

/** A doc's page in the viewer. */
export const docPath = (orgId: string, docId: string) => `/orgs/${orgId}/docs/${docId}`;

/** The list of deleted docs, to restore them. */
export const deletedDocsPath = (orgId: string) => `/orgs/${orgId}/docs/deleted`;
