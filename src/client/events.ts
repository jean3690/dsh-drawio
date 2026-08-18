/**
 * Browser-side subscription to the drawio activity SSE stream. The host
 * broadcasts every agent drawio tool success; the board auto-opens so the
 * user watches the AI draw without clicking anything.
 *
 * The host replays recent activity to each new connection. The FIRST open of
 * the stream processes that replay (a page loading after the drawing still
 * catches up); later reconnects skip replay entries older than this page
 * load, so a dropped connection cannot re-pop the board for stale activity.
 *
 * @module dsh-drawio/client/events
 */

export interface DrawioActivityEvent {
  kind: 'edit' | 'render' | 'template'
  path?: string
  /** Epoch millis when the activity was broadcast (present on host events). */
  time?: number
}

/** Open the EventSource; returns a disposer. */
export function subscribeDrawioEvents(onActivity: (activity: DrawioActivityEvent) => void): () => void {
  const source = new EventSource('/dsh-drawio/events')
  const pageLoadAt = Date.now()
  let openCount = 0
  source.onopen = (): void => { openCount += 1 }
  source.onmessage = (event: MessageEvent): void => {
    try {
      const parsed = JSON.parse(event.data as string) as DrawioActivityEvent
      // Replay entries predate this page load; they are handled on the first
      // open only — a reconnect must not re-trigger them.
      if (openCount > 1 && typeof parsed.time === 'number' && parsed.time < pageLoadAt) return
      onActivity(parsed)
    } catch {
      // Malformed payload: ignore.
    }
  }
  return () => { source.close() }
}
