/**
 * SVG → PNG rasterization for the agent `drawio_render` tool, plus the
 * attachment-store commit that lets the rendered diagram appear as an image
 * block in the conversation.
 *
 * @module dsh-drawio/raster
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Dynamic import keeps the native module out of the client bundle. */
async function loadResvg(): Promise<typeof import('@resvg/resvg-js')> {
  return import('@resvg/resvg-js')
}

export interface RasterResult {
  png: Uint8Array
  width: number
  height: number
}

/**
 * Rasterize an SVG document to PNG bytes.
 *
 * @param svg - the SVG markup.
 * @param scale - width multiplier (2 = double resolution).
 * @returns PNG bytes plus the intrinsic pixel size.
 */
export async function svgToPng(svg: string, scale = 2): Promise<RasterResult> {
  const { Resvg } = await loadResvg()
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: Math.max(0.25, Math.min(8, scale)) },
    font: {
      fontFiles: [],
      loadSystemFonts: true,
      defaultFontFamily: 'sans-serif',
    },
  })
  const rendered = resvg.render()
  const png = rendered.asPng()
  return { png, width: rendered.width, height: rendered.height }
}

/**
 * Commit PNG bytes into the harness attachment store, returning a durable
 * reference that conversation UIs can render.
 *
 * @param ctx - context carrying the attachment service.
 * @param png - PNG bytes.
 * @param name - optional display name.
 */
export async function savePngAttachment(ctx: Context, png: Uint8Array, name?: string): Promise<ImageAttachmentRef> {
  const ref = await ctx.attachments.saveImage({
    data: png,
    mediaType: 'image/png',
    ...(name === undefined ? {} : { name }),
  })
  return ref
}
