/**
 * Drawio 画板 panel controller: open/close state with subscriptions, shared by
 * the sidebar entry (DOM row) and the center-column view (React tree).
 *
 * @module dsh-drawio/client/controller
 */

export interface DrawioSnapshot {
  /** Whether the 画板 panel occupies the center column. */
  open: boolean
}

type Listener = () => void

/** Minimal observable open/close controller. */
export class DrawioController {
  private open = false
  private readonly listeners = new Set<Listener>()

  getSnapshot(): DrawioSnapshot {
    return { open: this.open }
  }

  toggle(): void {
    this.open = !this.open
    this.notify()
  }

  closeBoard(): void {
    if (!this.open) return
    this.open = false
    this.notify()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
