import type { BoardDocCardResponse } from "@inklayer/api";
import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type BoardDoc = BoardDocCardResponse;

export const boardApi = {
  /** The docs on the board's cards that this person can open, with the start of each one's text. */
  cards: (boardId: string, docIds: string[]) =>
    api.post("/api/boards/{boardId}/cards", { params: { path: { boardId } }, body: { docIds } }),
};

/** Previews go stale as people edit the docs: refetch this often. */
const PREVIEW_REFRESH_MS = 15_000;

export const boardQueries = {
  cards: (boardId: string, docIds: string[]) =>
    queryOptions({
      queryKey: ["boards", boardId, "cards", [...docIds].sort()],
      queryFn: () => boardApi.cards(boardId, docIds),
      enabled: docIds.length > 0,
      refetchInterval: PREVIEW_REFRESH_MS,
      placeholderData: (previous) => previous,
    }),
};
