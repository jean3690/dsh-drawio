/**
 * 画板 view mounting, side-column mode: the board lives in the drawio column
 * (a trailing grid item beside the conversation), so the user keeps the chat
 * visible while looking at the diagram. The conversation is never hidden or
 * unmounted — opening the board only widens the column.
 *
 * @module dsh-drawio/client/view-mount
 */

import { createRoot, type Root } from 'react-dom/client'
import type { DrawioCol } from './drawio-col.ts'
import type { DrawioRemote } from './api.ts'
import type { SessionListStore } from './board.tsx'
import { BoardView } from './board.tsx'

/**
 * Mount the 画板 React tree into the drawio column and bind its visibility to
 * the column controller.
 * @param col - the side-column controller (owns the container element).
 * @param makeApi - binds one workspace root to a fresh /dsh-drawio API client.
 * @param sessions - the session store (workspace root).
 * @param fontFamily - label font family list.
 * @returns disposer unmounting the tree.
 */
export function mountDrawioView(
  col: DrawioCol,
  makeApi: (root: string) => DrawioRemote,
  sessions: SessionListStore,
  fontFamily: string,
): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | null = null

  const ensure = (): void => {
    const column = col.element
    if (column === null) return
    if (container !== null && column.contains(container)) return
    container = document.createElement('div')
    container.dataset.dshDrawioView = ''
    container.style.cssText = 'display:flex;flex-direction:column;height:100%;min-width:0;'
    column.appendChild(container)
    root = createRoot(container)
    root.render(<BoardView makeApi={makeApi} sessions={sessions} fontFamily={fontFamily} />)
  }

  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })
  ensure()

  return () => {
    waitObserver.disconnect()
    root?.unmount()
    root = undefined
    container?.remove()
    container = null
  }
}