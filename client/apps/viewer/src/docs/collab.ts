import {
  HttpTransportType,
  type HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from "@microsoft/signalr";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import { api } from "@/lib/api";

/**
 * Live co-editing over the docs hub. The server stores and relays Yjs bytes; everything Yjs-specific happens here.
 * <ul>
 * <li>Edits are numbered by the server, 1, 2, 3… per doc. A session knows the highest number up to which it has every
 * edit, and only ever snapshots up to that number, so a snapshot can't drop an edit it hasn't seen.</li>
 * <li>After a reconnect, the session opens the doc again and sends whatever the server is missing (Yjs state diff), so
 * edits made while offline aren't lost.</li>
 * <li>Awareness (carets, selections, pointers) is relayed as-is.</li>
 * </ul>
 */

export interface Peer {
  id: string;
  userId: string;
  name: string;
  color: string;
}

interface OpenResult {
  docId: string;
  state: string | null;
  content: string;
  snapshotSeq: number;
  updates: { seq: number; bytes: string }[];
  canEdit: boolean;
  me: Peer;
  peers: Peer[];
}

export type SessionStatus = "connecting" | "live" | "offline" | "closed";

/** What each person's awareness state holds. `user` is what y-codemirror uses for carets. */
export interface AwarenessUser {
  name: string;
  color: string;
  colorLight: string;
  peerId: string;
}

const REMOTE = Symbol("remote");
const FLUSH_MS = 250;
const SNAPSHOT_IDLE_MS = 5000;
const AWARENESS_MS = 60;

/* ------------------------------------------------------------------ the shared connection */

class DocsHubConnection {
  readonly #sessions = new Map<string, DocSession>();
  #connection: HubConnection | null = null;
  #starting: Promise<HubConnection> | null = null;
  #retry = 0;

  register(session: DocSession): void {
    this.#sessions.set(session.docId, session);
  }

  /** The session for a doc open in this tab, if any. */
  find(docId: string): DocSession | undefined {
    return this.#sessions.get(docId);
  }

  unregister(session: DocSession): void {
    if (this.#sessions.get(session.docId) === session) this.#sessions.delete(session.docId);
  }

  get connected(): boolean {
    return this.#connection?.state === HubConnectionState.Connected;
  }

  async connection(): Promise<HubConnection> {
    if (this.#connection?.state === HubConnectionState.Connected) return this.#connection;
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start(): Promise<HubConnection> {
    const hub = new HubConnectionBuilder()
      .withUrl("/api/docs/hub", {
        transport: HttpTransportType.WebSockets,
        skipNegotiation: true,
        // A fresh single-use ticket for every attempt, bought with the session cookie.
        accessTokenFactory: async () => (await api.post("/api/presence/ticket")).ticket,
      })
      .withAutomaticReconnect([0, 1000, 3000, 5000, 10000, 20000])
      .configureLogging(LogLevel.Warning)
      .build();

    const to = (docId: string) => this.#sessions.get(docId);
    hub.on("update", (docId: string, seq: number, bytes: string) => to(docId)?.receiveUpdate(seq, bytes));
    hub.on("awareness", (docId: string, bytes: string) => to(docId)?.receiveAwareness(bytes));
    hub.on("peerJoin", (docId: string, peer: Peer) => to(docId)?.peerJoined(peer));
    hub.on("peerLeave", (docId: string, peerId: string, clientId: number) => to(docId)?.peerLeft(peerId, clientId));
    hub.on("compact", (docId: string) => void to(docId)?.snapshot());
    hub.on("access", (docId: string, canEdit: boolean) => to(docId)?.setCanEdit(canEdit));
    hub.on("closed", (docId: string, reason: string) => to(docId)?.closedByServer(reason));
    hub.onreconnecting(() => {
      for (const s of this.#sessions.values()) s.setStatus("connecting");
    });
    hub.onreconnected(() => {
      for (const s of this.#sessions.values()) void s.open();
    });
    hub.onclose(() => {
      if (this.#connection === hub) this.#connection = null;
      for (const s of this.#sessions.values()) s.setStatus("offline");
      if (this.#sessions.size > 0) {
        clearTimeout(this.#retry);
        this.#retry = window.setTimeout(() => this.#sessions.forEach((s) => void s.open()), 5000);
      }
    });

    await hub.start();
    this.#connection = hub;
    return hub;
  }
}

export const docsHub = new DocsHubConnection();

/* ------------------------------------------------------------------ one open doc */

export class DocSession {
  readonly docId: string;
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  readonly awareness: Awareness;

  status: SessionStatus = "connecting";
  canEdit = false;
  me: Peer | null = null;
  error = "";
  /** Other people with this doc open, by peer id. */
  readonly peers = new Map<string, Peer>();
  /** True once the server's copy has been loaded. */
  loaded = false;
  /** Send this person's caret, selection and pointer to others. Off when live cursors are turned off on the server. */
  shareAwareness = true;

  readonly #listeners = new Set<() => void>();
  readonly #applied = new Set<number>();
  /** Every edit numbered up to this has been applied here. */
  #contiguous = 0;
  #pending: Uint8Array[] = [];
  #flushTimer = 0;
  #snapshotTimer = 0;
  #awarenessTimer = 0;
  #sending: Promise<void> = Promise.resolve();
  /** Local edits not yet in a snapshot. */
  #dirty = false;
  #closed = false;

  constructor(docId: string) {
    this.docId = docId;
    this.text = this.doc.getText("content");
    this.awareness = new Awareness(this.doc);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || this.#closed) return;
      this.#pending.push(update);
      this.#dirty = true;
      clearTimeout(this.#flushTimer);
      this.#flushTimer = window.setTimeout(() => void this.flush(), FLUSH_MS);
      clearTimeout(this.#snapshotTimer);
      this.#snapshotTimer = window.setTimeout(() => void this.snapshot(), SNAPSHOT_IDLE_MS);
    });
    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin !== "local" || this.#closed) return;
        if (![...added, ...updated, ...removed].includes(this.doc.clientID)) return;
        clearTimeout(this.#awarenessTimer);
        this.#awarenessTimer = window.setTimeout(() => void this.#sendAwareness(), AWARENESS_MS);
      },
    );
    docsHub.register(this);
  }

  /** Re-renders on any change of status, people or access. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setStatus(status: SessionStatus): void {
    if (this.#closed && status !== "closed") return;
    this.status = status;
    this.#emit();
  }

  /** Opens (or re-opens after a reconnect) the doc, merging the server's copy with this one. */
  async open(): Promise<void> {
    if (this.#closed) return;
    this.setStatus("connecting");
    let result: OpenResult;
    try {
      const hub = await docsHub.connection();
      result = await hub.invoke<OpenResult>("Open", this.docId, this.doc.clientID);
    } catch (e) {
      this.error = cleanError(e);
      this.setStatus("offline");
      return;
    }
    if (this.#closed) return;

    // What the server has, in a scratch copy, to work out what it's missing from here.
    const server = new Y.Doc();
    const apply = (target: Y.Doc, bytes: string) => Y.applyUpdate(target, fromBase64(bytes), REMOTE);
    if (result.state) apply(server, result.state);
    for (const u of result.updates) apply(server, u.bytes);
    const missing = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(server));

    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(server), REMOTE);
    server.destroy();
    this.#applied.clear();
    this.#contiguous = result.snapshotSeq + result.updates.length;

    this.canEdit = result.canEdit;
    this.me = result.me;
    this.peers.clear();
    for (const peer of result.peers) this.peers.set(peer.id, peer);
    this.awareness.setLocalStateField("user", {
      name: result.me.name,
      color: result.me.color,
      colorLight: `${result.me.color}33`,
      peerId: result.me.id,
    } satisfies AwarenessUser);
    this.loaded = true;
    this.error = "";
    this.setStatus("live");

    // Edits made here while offline: send them now. (An empty diff is two bytes.)
    if (this.canEdit && missing.length > 2) {
      this.#pending.push(missing);
      this.#dirty = true;
      await this.flush();
    }
    void this.#sendAwareness();
  }

  /** Sends local edits, merged, one batch at a time. */
  flush(): Promise<void> {
    clearTimeout(this.#flushTimer);
    this.#sending = this.#sending.then(async () => {
      if (this.#pending.length === 0 || !this.canEdit || this.#closed) return;
      const batch = this.#pending;
      this.#pending = [];
      const merged = Y.mergeUpdates(batch);
      try {
        const hub = await docsHub.connection();
        const seq = await hub.invoke<number>("Update", this.docId, toBase64(merged));
        this.#markApplied(seq);
      } catch (e) {
        // Keep the edit; it goes again on the next flush, or as part of the diff after reconnecting.
        this.#pending.unshift(merged);
        this.error = cleanError(e);
        this.#emit();
        if (docsHub.connected) this.#flushTimer = window.setTimeout(() => void this.flush(), 2000);
      }
    });
    return this.#sending;
  }

  /** Saves the merged doc and its markdown on the server, replacing the edits it includes. */
  async snapshot(): Promise<void> {
    clearTimeout(this.#snapshotTimer);
    if (!this.canEdit || !this.loaded || this.#closed) return;
    await this.flush();
    if (this.#pending.length > 0) return;
    try {
      const hub = await docsHub.connection();
      await hub.invoke<boolean>(
        "Snapshot",
        this.docId,
        toBase64(Y.encodeStateAsUpdate(this.doc)),
        this.text.toString(),
        this.#contiguous,
      );
      this.#dirty = false;
    } catch (e) {
      this.error = cleanError(e);
      this.#emit();
    }
  }

  receiveUpdate(seq: number, bytes: string): void {
    Y.applyUpdate(this.doc, fromBase64(bytes), REMOTE);
    this.#markApplied(seq);
  }

  receiveAwareness(bytes: string): void {
    applyAwarenessUpdate(this.awareness, fromBase64(bytes), "remote");
  }

  peerJoined(peer: Peer): void {
    this.peers.set(peer.id, peer);
    this.#emit();
    void this.#sendAwareness(); // so they see this caret straight away
  }

  peerLeft(peerId: string, clientId: number): void {
    this.peers.delete(peerId);
    removeAwarenessStates(this.awareness, [clientId], "remote");
    this.#emit();
  }

  setCanEdit(canEdit: boolean): void {
    this.canEdit = canEdit;
    this.#emit();
  }

  closedByServer(reason: string): void {
    this.error = reason;
    this.canEdit = false;
    this.setStatus("closed");
  }

  /** Saves what's left and leaves the doc. */
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#dirty) await this.snapshot();
    else await this.flush();
    this.#closed = true;
    clearTimeout(this.#flushTimer);
    clearTimeout(this.#snapshotTimer);
    clearTimeout(this.#awarenessTimer);
    docsHub.unregister(this);
    if (docsHub.connected) await (await docsHub.connection()).invoke("Close", this.docId).catch(() => undefined);
    this.awareness.destroy();
    this.doc.destroy();
    this.status = "closed";
    this.#listeners.clear();
  }

  #markApplied(seq: number): void {
    if (seq <= this.#contiguous) return;
    this.#applied.add(seq);
    while (this.#applied.delete(this.#contiguous + 1)) this.#contiguous++;
  }

  async #sendAwareness(): Promise<void> {
    if (!this.loaded || this.#closed || !this.shareAwareness || !docsHub.connected) return;
    const update = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
    await (await docsHub.connection()).send("Awareness", this.docId, toBase64(update)).catch(() => undefined);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** Opens a doc just long enough to change its text, e.g. to rewrite links after a rename. */
export async function editDoc(docId: string, change: (text: Y.Text) => void): Promise<void> {
  // Already open in this tab: edit that copy (a second one would take its place on the connection).
  const open = docsHub.find(docId);
  if (open) {
    if (open.loaded && open.canEdit) open.doc.transact(() => change(open.text));
    return;
  }

  const session = new DocSession(docId);
  try {
    await session.open();
    if (!session.loaded || !session.canEdit) return;
    session.doc.transact(() => change(session.text));
    await session.snapshot();
  } finally {
    await session.close();
  }
}

function cleanError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.replace(/^.*HubException:\s*/, "");
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
