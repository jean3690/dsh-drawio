/**
 * Host-side drawio activity broadcast: the agent tools push an event every
 * time they touch a diagram file, and the browser half subscribes over SSE to
 * auto-open the board. One shared subscriber set; writes are fire-and-forget.
 *
 * @module dsh-drawio/events
 */

import type { ServerResponse } from 'node:http'

/** One diagram activity (agent tool touching a file). */
export interface DrawioActivity {
  kind: 'edit' | 'render' | 'template'
  /** Workspace-relative (or as-passed) path the agent operated on. */
  path?: string
}

const subscribers = new Set<ServerResponse>()

/** Register an SSE subscriber; returns its disposer. */
export function subscribeDrawioEvents(res: ServerResponse): () => void {
  subscribers.add(res)
  return () => { subscribers.delete(res) }
}

/** Push one activity to every subscriber (dead connections are dropped). */
export function broadcastDrawioActivity(activity: DrawioActivity): void {
  const line = `data: ${JSON.stringify(activity)}\n\n`
  for (const res of subscribers) {
    try {
      res.write(line)
    } catch {
      subscribers.delete(res)
    }
  }
}

/** Subscriber count (tests / diagnostics). */
export function drawioEventSubscriberCount(): number {
  return subscribers.size
}