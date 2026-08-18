/**
 * Diagram file watcher: polls every registered workspace root for changes to
 * .drawio files and broadcasts a drawio-activity event, so the board
 * auto-opens no matter HOW the agent wrote the file (drawio tools, the plain
 * file tools, or anything else). Filesystem watching is unreliable across
 * platforms for recursive trees, so this is a cheap mtime poll.
 *
 * @module dsh-drawio/watch
 */

import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import { broadcastDrawioActivity } from './events.ts'

const POLL_MS = 2500
const MAX_DEPTH = 4
const MAX_FILES = 800

/** The poll snapshot for one workspace root. */
type Snapshot = Map<string, number>

/**
 * Poll workspace roots for .drawio changes. Workspace registry membership is
 * read fresh every tick, so newly opened workspaces join automatically.
 */
export class DiagramWatchService {
  private readonly snapshots = new Map<string, Snapshot>()
  private timer: ReturnType<typeof setInterval> | undefined

  /** @param ctx - context carrying the workspace registry. */
  constructor(private readonly ctx: Context) {}

  /** Start polling (idempotent). */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => { void this.tick() }, POLL_MS)
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** One poll round: diff every registered workspace root. */
  private async tick(): Promise<void> {
    let workspaces: Array<{ path: string }> = []
    try {
      workspaces = this.ctx.workspaceRegistry.list()
    } catch {
      return
    }
    for (const workspace of workspaces) {
      try {
        await this.scanRoot(workspace.path)
      } catch {
        // A workspace may vanish mid-scan; skip it this round.
      }
    }
  }

  /** Scan one root and broadcast changes against the previous snapshot. */
  private async scanRoot(root: string): Promise<void> {
    const current = new Map<string, number>()
    const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || current.size >= MAX_FILES) return
      let entries
      try {
        entries = await readdir(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (current.size >= MAX_FILES) return
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
        const childAbs = join(abs, entry.name)
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) {
          await walk(childAbs, childRel, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        if (!entry.name.toLowerCase().endsWith('.drawio')) continue
        try {
          const info = await stat(childAbs)
          current.set(childRel, info.mtimeMs)
        } catch {
          // Vanished: skip.
        }
      }
    }
    await walk(root, '', 0)

    const previous = this.snapshots.get(root)
    this.snapshots.set(root, current)
    if (previous === undefined) return // first scan: baseline only

    for (const [path, mtime] of current) {
      if (previous.get(path) !== mtime) {
        broadcastDrawioActivity({ kind: 'edit', path })
      }
    }
    // Deleted files (present before, gone now) also count as activity.
    for (const path of previous.keys()) {
      if (!current.has(path)) {
        broadcastDrawioActivity({ kind: 'edit', path })
      }
    }
  }
}