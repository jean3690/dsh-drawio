/**
 * Static file serving for bundled assets (the drawio webapp): mounts a
 * `/drawio/*` prefix over a directory inside this package. Loopback-fenced
 * like every other plugin route; paths are normalized and must stay inside
 * the assets directory.
 *
 * @module dsh-drawio/static
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
}

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

/**
 * Serve one prefix from a directory on disk. Paths resolve inside `dir`
 * (after normalization; '..' and absolute escapes are rejected).
 */
export function serveStaticDir(ctx: Context, prefix: string, dir: string): () => void {
  const root = normalize(dir).replace(/[\\/]+$/, '')
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackRequest(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden: loopback-only')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    let rel = decodeURIComponent(url.pathname.slice(prefix.length))
    if (rel === '' || rel.endsWith('/')) rel += 'index.html'
    if (rel.includes('\0')) {
      res.writeHead(400)
      res.end()
      return
    }
    const target = normalize(join(root, rel.replace(/^[\\/]+/, '')))
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      res.writeHead(403)
      res.end()
      return
    }
    let info
    try {
      info = await stat(target)
    } catch {
      res.writeHead(404)
      res.end()
      return
    }
    if (info.isDirectory()) {
      res.writeHead(404)
      res.end()
      return
    }
    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, {
      'content-type': type,
      'content-length': info.size,
      'cache-control': 'public, max-age=3600',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(target)
    stream.on('error', () => {
      res.destroy()
    })
    stream.pipe(res)
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: prefix, handler })
  return () => dispose()
}