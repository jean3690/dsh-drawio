/**
 * Open-path hand-off between the SSE activity subscription (index.ts) and
 * the board (BoardView). The host replays recent activity right after the
 * SSE handshake — which can finish BEFORE the board React tree has mounted
 * (and before a workspace root is selected), so a plain window event would
 * be lost. The queue survives that race: paths are kept until the board
 * drains them. Live events after mount are delivered through listeners.
 *
 * @module dsh-drawio/client/open-queue
 */

const queue: string[] = []
const listeners = new Set<(path: string) => void>()

/** Remember (and notify) a path the agent is drawing. */
export function queueOpenPath(path: string): void {
  queue.push(path)
  if (queue.length > 20) queue.shift()
  for (const listener of listeners) {
    try {
      listener(path)
    } catch {
      // A listener must never break the broadcast loop.
    }
  }
}

/** Take all queued paths (oldest first); the caller opens the most recent. */
export function drainOpenPaths(): string[] {
  return queue.splice(0)
}

/** React to live open-path events (returns the disposer). */
export function subscribeOpenPath(listener: (path: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
