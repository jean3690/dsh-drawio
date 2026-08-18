/**
 * Browser-side subscription to the drawio activity SSE stream. The host
 * broadcasts every agent drawio tool success; the board auto-opens so the
 * user watches the AI draw without clicking anything.
 *
 * @module dsh-drawio/client/events
 */

export interface DrawioActivityEvent {
  kind: 'edit' | 'render' | 'template'
  path?: string
}

/** Open the EventSource; returns a disposer. */
export function subscribeDrawioEvents(onActivity: (activity: DrawioActivityEvent) => void): () => void {
  const source = new EventSource('/dsh-drawio/events')
  source.onmessage = (event: MessageEvent): void => {
    try {
      const parsed = JSON.parse(event.data as string) as DrawioActivityEvent
      onActivity(parsed)
    } catch {
      // Malformed payload: ignore.
    }
  }
  return () => { source.close() }
}