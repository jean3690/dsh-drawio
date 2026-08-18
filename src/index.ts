/**
 * dsh-drawio — a diagrams.net (drawio) plugin for the DeepSeek Harness web
 * GUI.
 *
 * Host half: the agent drawio tools (drawio_validate / drawio_render /
 * drawio_template), the /dsh-drawio HTTP routes (workspace-gated
 * list/read/save for the 画板 — plain fetch, the family pattern), and PNG
 * rasterization for inline chat previews. The browser half (exports
 * "./client") mounts the sidebar entry and the 画板 view.
 *
 * Function plugin — no default export (the Loader unwraps
 * `exports.default ?? exports`).
 *
 * @module dsh-drawio
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import { fileURLToPath } from 'node:url'
import type { Config } from './config.ts'
import { resolveConfig } from './config.ts'
import { DrawioService } from './service.ts'
import { registerDrawioRoutes } from './routes.ts'
import { serveStaticDir } from './static.ts'
import { DiagramWatchService } from './watch.ts'
import { buildAgentTools } from './tools.ts'

export const name = 'dsh-drawio'

/** Hard services: the tool registry + workspace registry + web server. */
export const inject = ['tools', 'workspaceRegistry', 'webServer', 'loader']

export { resolveConfig } from './config.ts'
export type { Config } from './config.ts'
export { DrawioService, verifyWorkspaceRoot, isPathInside, normalizeForPrefix, DIAGRAM_EXTENSIONS } from './service.ts'
export { registerDrawioRoutes } from './routes.ts'
export { serveStaticDir } from './static.ts'
export { buildAgentTools, buildTemplate, renderResultText } from './tools.ts'
export { applyEditOps, serializeXml } from './edit.ts'
export type { EditOp, EditPoint, EditResult, EditOpResult } from './edit.ts'
export { svgToPng, savePngAttachment } from './raster.ts'
export * from './translate.ts'
export type * from './protocol.ts'

/**
 * Mount the drawio plugin: the /dsh-drawio routes (board file ops) and the
 * agent tools (config-gated exposure).
 *
 * @param ctx - context carrying tools + workspaceRegistry + webServer + loader.
 * @param config - raw loader config; defaults applied through {@link resolveConfig}.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)

  // The board's workspace file service + its HTTP routes.
  const service = new DrawioService(ctx)
  const disposeRoutes = registerDrawioRoutes(ctx, service)
  ctx.effect(() => () => disposeRoutes(), 'dsh-drawio: /dsh-drawio routes')

  // The bundled drawio webapp (official editor) at /drawio/*.
  const webappDir = fileURLToPath(new URL('../assets/drawio-webapp', import.meta.url))
  const disposeStatic = serveStaticDir(ctx, '/drawio', webappDir)
  ctx.effect(() => () => disposeStatic(), 'dsh-drawio: /drawio static')

  // Watch every registered workspace for .drawio changes, so the board
  // auto-opens whenever the agent writes a diagram file — regardless of the
  // tool used (drawio_* tools broadcast directly; this catches plain file
  // writes and deletions too).
  const watcher = new DiagramWatchService(ctx)
  watcher.start()
  ctx.effect(() => () => watcher.stop(), 'dsh-drawio: diagram watcher')

  // Agent tools: expose the configured subset.
  ctx.inject(['tools'], (scope) => {
    const defs = buildAgentTools(ctx, resolved)
    scope.effect(() => {
      const disposers = defs.map(def => scope.tools.register(def))
      return () => { for (const dispose of disposers) dispose() }
    }, `dsh-drawio: ${defs.length} agent tool(s)`)
  })

  // Keep a reference so the service's fiber stays reachable.
  void service
}