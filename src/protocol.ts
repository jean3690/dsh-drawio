/**
 * Shared wire vocabulary between the /dsh-drawio HTTP routes and the 画板
 * browser client (plain JSON — no typert machinery, matching how dsh-ssh and
 * dsh-aionui-panel talk to their panels).
 *
 * @module dsh-drawio/protocol
 */

/** One diagram file entry (list result). */
export interface ListEntry {
  /** Workspace-relative path (forward slashes). */
  path: string
  /** File name (basename). */
  name: string
  /** Byte size. */
  size: number
  /** mtime epoch millis. */
  mtime: number
}

/** List one workspace directory for diagram files. */
export interface ListRequest {
  /** Absolute project root (session cwd); must be inside a registered workspace. */
  root: string
  /** Optional subdirectory ('' = root); recursive scan with a depth cap. */
  dir?: string
}

/** List response body. */
export interface ListResult {
  entries: ListEntry[]
  /** Total files found (after the scan cap). */
  truncated: boolean
}

/** Read one diagram file. */
export interface ReadRequest {
  root: string
  path: string
}

/** Read response body. */
export interface ReadResult {
  content: string
  mtime: number
}

/** Save one diagram file (create/overwrite inside the workspace). */
export interface SaveRequest {
  root: string
  /** Workspace-relative destination path; must end in .drawio/.xml/.svg. */
  path: string
  content: string
}

/** Save response body. */
export interface SaveResult {
  path: string
  bytes: number
  mtime: number
}

/** One route response envelope. */
export type DrawioEnvelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }