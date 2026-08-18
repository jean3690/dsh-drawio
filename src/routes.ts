/**
 * /dsh-drawio/* route layer: JSON envelope (ok/error) for the workspace
 * diagram file operations behind the loopback fence — the same judgment
 * dsh-ssh and dsh-aionui-panel apply to their host routes: a LAN-exposed
 * dsh web must not serve workspace file operations to unpaired devices.
 *
 * @module dsh-drawio/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { DrawioEnvelope } from './protocol.ts'
import type { DrawioService, DrawioOpResult } from './service.ts'
import { subscribeDrawioEvents } from './events.ts'

/** Loopback trust fence (mirrors dsh-ssh / dsh-aionui-panel). */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function forbidden(res: ServerResponse): void {
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'forbidden: loopback-only' }))
}

/** Read a JSON request body into an unknown value; null when unparseable. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    chunks.push(buffer)
    total += buffer.length
    // 16 MiB ceiling: comfortably above the 8 MiB per-file read cap so saving
    // a large diagram never hits the body limit.
    if (total > 16 << 20) return null
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** Extract the required string field from a JSON object payload. */
function strField(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** Extract a string field, accepting the empty string as a value. */
function strOrEmpty(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

const BAD_REQUEST = { code: 'internal', message: 'malformed request' } as const

function json(res: ServerResponse, envelope: DrawioEnvelope<unknown>, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

/** Map an operation result onto the HTTP envelope. */
function respond(res: ServerResponse, result: DrawioOpResult): void {
  switch (result.kind) {
    case 'list':
    case 'read':
    case 'stat':
    case 'save':
      json(res, { ok: true, value: result.value })
      return
    case 'error': {
      const status = result.error.code === 'workspace' ? 403 : result.error.code === 'not-found' ? 404 : result.error.code === 'invalid' ? 422 : 500
      json(res, { ok: false, error: result.error }, status)
      return
    }
  }
}

/**
 * Register the /dsh-drawio routes (POST JSON operations).
 * @param ctx - context carrying the webServer service.
 * @param service - the gated filesystem service.
 * @returns the route disposer.
 */
export function registerDrawioRoutes(ctx: Context, service: DrawioService): () => void {
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Loopback fence first: never let a LAN client reach any /dsh-drawio
    // operation, regardless of method or content-type.
    if (!isLoopbackRequest(req)) {
      forbidden(res)
      return
    }
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.writeHead(405)
      res.end()
      return
    }

    // GET /dsh-drawio/raw: stream one workspace file for the drawio editor's
    // `?url=` loader. Loopback-fenced + workspace-gated.
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/dsh-drawio/events') {
        // SSE: drawio activity broadcast (auto-open the board when the agent
        // draws). Loopback-fenced above; keep-alive so proxies don't drop it.
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write('retry: 2000\n\n')
        const heartbeat = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch {
            clearInterval(heartbeat)
          }
        }, 15000)
        const unsubscribe = subscribeDrawioEvents(res)
        req.on('close', () => {
          unsubscribe()
          clearInterval(heartbeat)
        })
        return
      }
      if (url.pathname === '/dsh-drawio/raw') {
        const root = url.searchParams.get('root')
        const path = url.searchParams.get('path')
        if (root === null || root === '' || path === null || path === '') {
          json(res, { ok: false, error: BAD_REQUEST }, 400)
          return
        }
        const result = await service.read(root, path)
        if (result.kind !== 'read') {
          const status = result.kind === 'error' && result.error.code === 'workspace' ? 403 : result.kind === 'error' && result.error.code === 'not-found' ? 404 : 500
          json(res, { ok: false, error: result.kind === 'error' ? result.error : BAD_REQUEST }, status)
          return
        }
        res.writeHead(200, {
          'content-type': 'application/xml; charset=utf-8',
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
        })
        res.end(result.value.content)
        return
      }
      res.writeHead(404)
      res.end()
      return
    }
    // Everything below is POST-only.
    // Require an explicit JSON content-type: cross-site simple requests (no
    // preflight) cannot set application/json, so this blocks form-based CSRF
    // from driving the workspace routes.
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      json(res, { ok: false, error: BAD_REQUEST }, 415)
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const payload = await readJsonBody(req)
    if (payload === null) {
      json(res, { ok: false, error: BAD_REQUEST })
      return
    }
    switch (pathname) {
      case '/dsh-drawio/list': {
        const root = strField(payload, 'root')
        if (root === null) {
          json(res, { ok: false, error: BAD_REQUEST })
          return
        }
        respond(res, await service.list(root, strField(payload, 'dir') ?? undefined))
        return
      }
      case '/dsh-drawio/read': {
        const root = strField(payload, 'root')
        const path = strField(payload, 'path')
        if (root === null || path === null) {
          json(res, { ok: false, error: BAD_REQUEST })
          return
        }
        respond(res, await service.read(root, path))
        return
      }
      case '/dsh-drawio/stat': {
        const root = strField(payload, 'root')
        const path = strField(payload, 'path')
        if (root === null || path === null) {
          json(res, { ok: false, error: BAD_REQUEST })
          return
        }
        respond(res, await service.stat(root, path))
        return
      }
      case '/dsh-drawio/save': {
        const root = strField(payload, 'root')
        const path = strField(payload, 'path')
        const content = strOrEmpty(payload, 'content')
        if (root === null || path === null || content === null) {
          json(res, { ok: false, error: BAD_REQUEST })
          return
        }
        respond(res, await service.save(root, path, content))
        return
      }
      default:
        res.writeHead(404)
        res.end()
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/dsh-drawio', handler })
  return () => dispose()
}