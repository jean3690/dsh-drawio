/**
 * Sidebar entry injection.
 *
 * The dsh sidebar shell exposes no slot an external plugin can register into,
 * so — following the established task-board / ssh / toolbox precedent of
 * DOM-level extension — the entry row is injected after the sibling family
 * block. The injection self-heals: a MutationObserver watches the sidebar
 * root and re-inserts the row whenever a React re-render displaces it.
 */
import type { DrawioController } from './controller.ts'
import { t } from './i18n.ts'
import { ICON_SVG } from './board.tsx'
import styles from './board.module.css'

/** Stable data attribute identifying the injected entry row. */
export const ENTRY_SELECTOR = '[data-dsh-drawio-entry]'

/** Family rows injected by sibling plugins (kept in stable relative order). */
const FAMILY_SELECTOR = '[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-devtoolbox-entry]'

/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** The New Session button: nested in the logo row on current shells. */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of Array.from(root.children)) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** Build the entry row (a detached button; inserted once the shell is up). */
function createEntry(controller: DrawioController): HTMLButtonElement {
  const label = t('entry.label')
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshDrawioEntry = ''
  entry.className = styles.entry!
  entry.setAttribute('aria-label', label)
  entry.innerHTML = `<span class="${styles.entryIcon}">${ICON_SVG}</span><span>${label}</span>`
  entry.addEventListener('click', () => { controller.toggle() })
  return entry
}

/** Re-insert the entry after the New Session row / sibling family block. */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement === root) return true
  const row = button.closest('[class*="logoRow"]')
  const base = (row !== null && row.parentElement === root) ? row : button
  const family = Array.from(root.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.matches(FAMILY_SELECTOR),
  )
  // After the whole family block (stable: never competes with siblings for
  // the first slot, so relative order cannot flip between re-renders).
  const anchor = family.length > 0 ? family[family.length - 1]!.nextElementSibling : base.nextElementSibling
  root.insertBefore(entry, anchor)
  return true
}

/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 * @param controller - the controller the entry toggles.
 * @returns disposer removing the entry and its observers.
 */
export function mountSidebarEntry(controller: DrawioController): () => void {
  const entry = createEntry(controller)
  let root: HTMLElement | undefined
  let placed = false
  let rootObserver: MutationObserver | undefined

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver?.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver?.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) {
      rootObserver ??= new MutationObserver(() => {
        if (root === undefined || !root.isConnected) {
          placed = false
          tryPlace()
          return
        }
        if (!root.contains(entry)) placeEntry(root, entry)
      })
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }

  // Body-level watcher as the "whole rebuild" fallback.
  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // Reflect open state on the row (active highlight).
  const syncActive = (): void => {
    if (controller.getSnapshot().open) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribe = controller.subscribe(syncActive)
  syncActive()
  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver?.disconnect()
    unsubscribe()
    entry.remove()
  }
}
