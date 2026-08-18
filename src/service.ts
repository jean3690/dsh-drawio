/**
 * The drawio host service: workspace-gated diagram file operations for the
 * 画板 browser UI (list / read / save), served over the /dsh-drawio HTTP
 * routes (see routes.ts). Every operation canonicalizes the requested root
 * and requires it to be inside a registered workspace — the same security
 * boundary the /aionui-panel routes enforce: the browser may only read and
 * mutate files under registered workspace roots.
 *
 * @module dsh-drawio/service
 */

import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import { parseDiagrams } from './translate.ts'
import type { ListEntry, ReadResult, SaveResult } from './protocol.ts'

/** Diagram file extensions the board lists. */
export const DIAGRAM_EXTENSIONS = new Set(['.drawio', '.xml', '.drawio.svg', '.svg'])

/** Recursion depth cap for the recursive list scan. */
const MAX_SCAN_DEPTH = 6
/** Cap on listed entries (browser trees must stay light). */
const MAX_ENTRIES = 500
/** Cap on a single file read. */
const MAX_READ_BYTES = 8 * 1024 * 1024

/** The gate verdict for one project root. */
export type GateVerdict = { ok: true; canonical: string } | { ok: false; error: string }

/**
 * Normalize a path for prefix comparison: collapse Windows separators to `/`
 * and drop any trailing slash; on win32 compare case-insensitively.
 */
export function normalizeForPrefix(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** The canonical prefix check: child must live inside (or equal) the root. */
export function isPathInside(root: string, child: string): boolean {
  if (root === '' || child === '') return false
  const normRoot = normalizeForPrefix(root)
  const normChild = normalizeForPrefix(child)
  if (normChild === normRoot) return true
  return normChild.startsWith(`${normRoot}/`)
}

/**
 * Verify a project root: canonicalize and require membership in a registered
 * workspace.
 * @param ctx - context carrying the workspace registry.
 * @param root - the requested project root (session cwd).
 */
export async function verifyWorkspaceRoot(ctx: Context, root: string): Promise<GateVerdict> {
  if (typeof root !== 'string' || root === '') {
    return { ok: false, error: 'empty project root' }
  }
  let canonical: string
  try {
    canonical = await realpath(root)
  } catch {
    return { ok: false, error: 'path does not resolve on disk' }
  }
  const workspaces = ctx.workspaceRegistry.list()
  for (const workspace of workspaces) {
    if (isPathInside(workspace.path, canonical)) {
      return { ok: true, canonical }
    }
  }
  return { ok: false, error: 'path is not inside a registered workspace' }
}

/** A workspace-relative path, validated for traversal safety. */
function safeRelative(root: string, path: string): string | null {
  const clean = path.replaceAll('\\', '/').replace(/^\/+/, '')
  const target = resolve(root, clean)
  if (!isPathInside(root, target)) return null
  return clean
}

/** One workspace-gated operation result. */
export type DrawioOpResult =
  | { kind: 'list'; value: { entries: ListEntry[]; truncated: boolean } }
  | { kind: 'read'; value: ReadResult }
  | { kind: 'save'; value: SaveResult }
  | { kind: 'error'; error: { code: string; message: string } }

/** The drawio workspace file service (plain service; no typert). */
export class DrawioService {
  static inject = [] as const

  /** @param ctx - cordis context. */
  constructor(private readonly ctx: Context) {}

  /** List diagram files under a workspace directory (recursive, depth-capped). */
  async list(rootArg: string, dirArg: string | undefined): Promise<DrawioOpResult> {
    const gated = await verifyWorkspaceRoot(this.ctx, rootArg)
    if (!gated.ok) return { kind: 'error', error: { code: 'workspace', message: gated.error } }
    const root = gated.canonical
    const dir = dirArg === undefined || dirArg === '' ? '' : safeRelative(root, dirArg)
    if (dir === null) return { kind: 'error', error: { code: 'workspace', message: 'path escapes the workspace' } }
    const base = dir === '' ? root : join(root, ...dir.split('/'))
    const entries: ListEntry[] = []
    let truncated = false

    const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
      if (truncated || depth > MAX_SCAN_DEPTH) return
      let handle
      try {
        handle = await readdir(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of handle) {
        if (truncated || entries.length >= MAX_ENTRIES) {
          truncated = true
          return
        }
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
        const childAbs = join(abs, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
          await walk(childAbs, childRel, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        const lower = entry.name.toLowerCase()
        if (lower.endsWith('.drawio') || lower.endsWith('.drawio.svg')) {
          try {
            const info = await stat(childAbs)
            entries.push({ path: childRel, name: entry.name, size: info.size, mtime: Math.floor(info.mtimeMs) })
          } catch {
            // Vanished between readdir and stat: skip.
          }
        }
      }
    }
    await walk(base, dir, 0)
    entries.sort((a, b) => a.path.localeCompare(b.path))
    return { kind: 'list', value: { entries, truncated } }
  }

  /** Read one diagram file's content. */
  async read(rootArg: string, path: string): Promise<DrawioOpResult> {
    const gated = await verifyWorkspaceRoot(this.ctx, rootArg)
    if (!gated.ok) return { kind: 'error', error: { code: 'workspace', message: gated.error } }
    const root = gated.canonical
    const rel = safeRelative(root, path)
    if (rel === null) return { kind: 'error', error: { code: 'workspace', message: 'path escapes the workspace' } }
    const target = join(root, ...rel.split('/'))
    let info
    try {
      info = await stat(target)
    } catch {
      return { kind: 'error', error: { code: 'not-found', message: `no such file: ${rel}` } }
    }
    if (!info.isFile()) return { kind: 'error', error: { code: 'not-found', message: `not a file: ${rel}` } }
    if (info.size > MAX_READ_BYTES) {
      return { kind: 'error', error: { code: 'too-large', message: `file too large (${info.size} bytes)` } }
    }
    try {
      const content = await readFile(target, 'utf8')
      return { kind: 'read', value: { content, mtime: Math.floor(info.mtimeMs) } }
    } catch (error) {
      return { kind: 'error', error: { code: 'io', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  /**
   * Save one diagram file into the workspace. The content must parse as a
   * drawio document (unless the extension is .svg), so the board can never
   * persist garbage the renderer would choke on.
   */
  async save(rootArg: string, path: string, content: string): Promise<DrawioOpResult> {
    const gated = await verifyWorkspaceRoot(this.ctx, rootArg)
    if (!gated.ok) return { kind: 'error', error: { code: 'workspace', message: gated.error } }
    const root = gated.canonical
    const rel = safeRelative(root, path)
    if (rel === null) return { kind: 'error', error: { code: 'workspace', message: 'path escapes the workspace' } }
    const lower = rel.toLowerCase()
    if (!lower.endsWith('.drawio') && !lower.endsWith('.xml') && !lower.endsWith('.svg')) {
      return { kind: 'error', error: { code: 'invalid', message: 'only .drawio/.xml/.svg files can be saved' } }
    }
    if (!lower.endsWith('.svg')) {
      try {
        parseDiagrams(content)
      } catch (error) {
        return {
          kind: 'error',
          error: { code: 'invalid', message: `content is not a valid drawio document: ${error instanceof Error ? error.message : String(error)}` },
        }
      }
    }
    const target = join(root, ...rel.split('/'))
    try {
      await mkdir(dirname(target), { recursive: true })
      const bytes = Buffer.byteLength(content, 'utf8')
      await writeFile(target, content, 'utf8')
      const info = await stat(target)
      return { kind: 'save', value: { path: rel, bytes, mtime: Math.floor(info.mtimeMs) } }
    } catch (error) {
      return { kind: 'error', error: { code: 'io', message: error instanceof Error ? error.message : String(error) } }
    }
  }
}