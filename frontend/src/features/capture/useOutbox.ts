import { useCallback, useEffect, useState } from "react";
import { sessionStore } from "../../api/auth/session";
import {
  outboxRepository,
  subscribeOutbox,
} from "../../app/offline/outbox/outboxRepository";
import { isStale } from "../../app/offline/outbox/stateMachine";
import type { OutboxItem } from "../../app/offline/outbox/types";

/** The signed-in user's queued entries, kept current as the outbox changes.
 *  A storage problem reads as an empty queue here; the capture sheet is where
 *  storage failures are loud, because that is where data can be lost. */
export function useOutbox() {
  const userId = sessionStore.readHint()?.userId ?? null;
  const [items, setItems] = useState<OutboxItem[]>([]);

  const refresh = useCallback(async () => {
    if (!userId) {
      setItems([]);
      return;
    }
    try {
      setItems(await outboxRepository.list(userId));
    } catch {
      setItems([]);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
    return subscribeOutbox(() => void refresh());
  }, [refresh]);

  const pending = items.filter((item) => item.status !== "synced");
  const now = new Date();
  return {
    items,
    pending,
    failed: pending.filter((item) => item.status === "failed"),
    stale: pending.filter((item) => isStale(item, now)),
    refresh,
  };
}
