/**
 * dsh-drawio, browser half: injects the sidebar entry row and the
 * center-column 画板 view (DOM-level surfaces following the task-board /
 * toolbox precedent). Host communication goes over the /dsh-drawio HTTP
 * routes via plain fetch — no typert remote machinery (the family pattern:
 * dsh-ssh and dsh-aionui-panel do the same). Failure policy: DOM mounting
 * problems are logged, never thrown — an external plugin must not take the
 * web GUI down.
 *
 * @module dsh-drawio/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { DrawioController } from './controller.ts'
import { DrawioCol } from './drawio-col.ts'
import { subscribeDrawioEvents } from './events.ts'
import { queueOpenPath } from './open-queue.ts'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { mountDrawioView } from './view-mount.tsx'
import { DrawioApi, type DrawioRemote } from './api.ts'
import { ZH, EN } from './locales.ts'
import type { SessionListStore } from './board.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Drawio surface copy. */
    'drawio': string
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'drawio'

/** Plugin name: matches the package name, the graph row id, and the bundle id. */
export const name = 'dsh-drawio'

/** Services the surfaces read. */
export const inject = ['slots', 'locale', 'sessions']

/** Bind one workspace root to a fresh API client (rebuilt on session switch). */
function makeApi(root: string): DrawioRemote {
  return new DrawioApi(root)
}

/**
 * Browser plugin body: dictionaries, the sidebar entry, and the center-column
 * 画板 view.
 *
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-drawio: dictionaries')

  const controller = new DrawioController()
  const col = new DrawioCol()
  col.mount()
  // The controller owns the open state (sidebar highlight); the column
  // mirrors it (widens / collapses beside the conversation).
  const syncCol = (): void => { col.setOpen(controller.getSnapshot().open) }
  const unsubscribeCol = controller.subscribe(syncCol)
  syncCol()
  const disposers: Array<() => void> = []
  // Agent drawio activity -> auto-open the board and point it at the file
  // the agent is drawing. The path goes through the open queue (not a window
  // event): the SSE replay can arrive before the board tree has mounted its
  // listeners, and the board drains the queue once a root is available.
  disposers.push(subscribeDrawioEvents((activity) => {
    col.setOpen(true)
    if (typeof activity.path === 'string' && activity.path !== '') {
      queueOpenPath(activity.path)
    }
  }))
  try {
    const fontFamily = typeof document !== 'undefined'
      ? getComputedStyle(document.documentElement).getPropertyValue('--dsh-drawio-font')?.trim() || undefined
      : undefined
    disposers.push(mountSidebarEntry(controller))
    disposers.push(mountDrawioView(
      col,
      makeApi,
      ctx.sessions.list as unknown as SessionListStore,
      fontFamily ?? "Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif",
    ))
  } catch (error) {
    // DOM failures degrade the 画板, never the GUI.
    console.error('[dsh-drawio] mount failed:', error)
  }

  ctx.effect(() => () => {
    unsubscribeCol()
    for (const dispose of disposers.splice(0)) dispose()
    col.dispose()
  }, 'dsh-drawio: surfaces')
}