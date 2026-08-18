/**
 * Browser-side API client for the /dsh-drawio route family — plain fetch,
 * same origin, the same pattern dsh-ssh and dsh-aionui-panel use for their
 * panels.
 *
 * @module dsh-drawio/client/api
 */

import type { DrawioEnvelope, ListResult, ReadResult, SaveResult } from '../protocol.ts'

/** Error carrying the route's JSON error message. */
export class DrawioApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DrawioApiError'
  }
}

/** Parse a JSON envelope response or throw a DrawioApiError. */
async function post<T>(path: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new DrawioApiError(`network error: ${error instanceof Error ? error.message : String(error)}`)
  }
  let envelope: DrawioEnvelope<T>
  try {
    envelope = await response.json() as DrawioEnvelope<T>
  } catch {
    throw new DrawioApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!envelope.ok) {
    throw new DrawioApiError(`${envelope.error.code}: ${envelope.error.message}`)
  }
  return envelope.value
}

/** The board's host face: workspace-gated list/read/save bound to one root. */
export interface DrawioRemote {
  list: (request: { root: string; dir?: string }) => Promise<ListResult>
  read: (request: { root: string; path: string }) => Promise<ReadResult>
  save: (request: { root: string; path: string; content: string }) => Promise<SaveResult>
}

/** Fetch-based implementation of {@link DrawioRemote}. */
export class DrawioApi implements DrawioRemote {
  /** @param root - the workspace root (session cwd) every call is bound to. */
  constructor(private readonly root: string) {}

  list(request: { root: string; dir?: string }): Promise<ListResult> {
    return post<ListResult>('/dsh-drawio/list', { root: this.root, dir: request.dir })
  }

  read(request: { root: string; path: string }): Promise<ReadResult> {
    return post<ReadResult>('/dsh-drawio/read', { root: this.root, path: request.path })
  }

  save(request: { root: string; path: string; content: string }): Promise<SaveResult> {
    return post<SaveResult>('/dsh-drawio/save', { root: this.root, path: request.path, content: request.content })
  }
}