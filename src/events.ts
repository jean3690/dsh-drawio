/**
 * Host-side drawio activity broadcast: the agent tools push an event every
 * time they touch a diagram file, and the browser half subscribes over SSE to
 * auto-open the board. One shared subscriber set; writes are fire-and-forget.
 *
 * Recent activity is kept in a small ring buffer and replayed to every NEW
 * subscriber, so a page that connects AFTER the drawing — a tab reloaded
 * after a host restart, or a fresh tab — still catches up and auto-opens the
 * board instead of silently missing the broadcast.
 *
 * @module dsh-drawio/events
 */

import type { ServerResponse } from 'node:http'

/** One diagram activity (agent tool touching a file). */
export interface DrawioActivity {
  kind: 'edit' | 'render' | 'template'
  /** Workspace-relative (or as-passed) path the agent operated on. */
  path?: string
  /** Epoch millis when the activity was broadcast (replay dedupe on the client). */
  time?: number
}

const subscribers = new Set<ServerResponse>()

/** Replay ring: the newest activities, kept briefly so late joiners catch up. */
const RECENT_LIMIT = 20
const RECENT_TTL_MS = 10 * 60 * 1000
const recent: DrawioActivity[] = []

/** Register an SSE subscriber; replays recent activity, then returns its disposer. */
export function subscribeDrawioEvents(res: ServerResponse): () => void {
  const cutoff = Date.now() - RECENT_TTL_MS
  for (const activity of recent) {
    if (activity.time !== undefined && activity.time < cutoff) continue
    try {
      res.write(`data: ${JSON.stringify(activity)}\n\n`)
    } catch {
      // Subscriber gone mid-replay: stop replaying to it.
      break
    }
  }
  subscribers.add(res)
  return () => { subscribers.delete(res) }
}

/** Push one activity to every subscriber (dead connections are dropped). */
export function broadcastDrawioActivity(activity: DrawioActivity): void {
  const stamped: DrawioActivity = { ...activity, time: Date.now() }
  recent.push(stamped)
  if (recent.length > RECENT_LIMIT) recent.shift()
  const line = `data: ${JSON.stringify(stamped)}\n\n`
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
