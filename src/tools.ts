/**
 * The three agent-visible drawio tools: validate, render, and template.
 *
 * - `drawio_validate`: parse a workspace .drawio file or inline XML; report
 *   diagrams/cells/edges and any structural notes.
 * - `drawio_render`: parse and render to SVG (and optionally PNG), write the
 *   outputs next to the source file inside the workspace, and — when the
 *   attachment store is available — commit a PNG preview so the diagram
 *   appears inline in the conversation.
 * - `drawio_template`: emit a ready-to-edit mxfile skeleton for common
 *   diagram kinds (flowchart / architecture / network / orgchart).
 *
 * @module dsh-drawio/tools
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.ts'
import { exposed } from './config.ts'
import { applyEditOps, type EditOp, type EditPoint, type EditResult } from './edit.ts'
import { broadcastDrawioActivity } from './events.ts'
import { savePngAttachment, svgToPng } from './raster.ts'
import { verifyWorkspaceRoot } from './service.ts'
import { diagramToSvg, parseDiagrams, type Diagram } from './translate.ts'

/** The tool result contract (validated against the output schema). */
export interface DrawioToolResult {
  ok: boolean
  action: string
  source: string
  diagrams: number
  vertices: number
  edges: number
  issues: string[]
  files: string[]
  error?: string
  /** drawio_edit: ops applied / failed. */
  applied?: number
  failed?: number
  /** PNG preview committed to the attachment store (chat image block). */
  preview?: ImageAttachmentRef
}

/** Output JSON schema (author-style annotations; matches dsh-tools). */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    action: { type: 'string', required: true },
    source: { type: 'string', required: true },
    diagrams: { type: 'integer', required: true },
    vertices: { type: 'integer', required: true },
    edges: { type: 'integer', required: true },
    issues: { type: 'array', items: { type: 'string' }, required: true },
    files: { type: 'array', items: { type: 'string' }, required: true },
    error: { type: 'string' },
    applied: { type: 'integer' },
    failed: { type: 'integer' },
    preview: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string' },
        mediaType: { type: 'string' },
        bytes: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        name: { type: 'string' },
      },
    },
  },
} as const

/** Count vertices/edges across the whole cell tree. */
function countCells(diagram: Diagram): { vertices: number; edges: number } {
  let vertices = 0
  let edges = 0
  const walk = (cells: Diagram['cells']): void => {
    for (const cell of cells) {
      if (cell.edge) edges += 1
      else if (cell.vertex) vertices += 1
      walk(cell.children as Diagram['cells'])
    }
  }
  walk(diagram.cells)
  return { vertices, edges }
}

/** The current session's cwd, best effort ('' when unknown). */
function sessionCwd(ctx: Context): string {
  try {
    const sessions = ctx.sessions.list()
    for (let i = sessions.length - 1; i >= 0; i -= 1) {
      const session = sessions[i] as unknown as { meta?: { cwd?: unknown }; cwd?: unknown }
      const cwd = session.meta?.cwd ?? session.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
    }
  } catch {
    // Session store unavailable: fall through.
  }
  return ''
}

/** Resolve a tool path argument to an absolute path ('' when unresolvable). */
function resolvePathArg(ctx: Context, path: string | undefined): string {
  if (path === undefined || path === '') return ''
  if (isAbsolute(path)) return path
  const cwd = sessionCwd(ctx)
  return cwd === '' ? '' : resolve(cwd, path)
}

/** Read a source (path or inline xml); returns content + label or an error. */
async function resolveSource(
  ctx: Context,
  path: string | undefined,
  xml: string | undefined,
): Promise<{ ok: true; content: string; label: string; absPath: string } | { ok: false; error: string }> {
  if ((path === undefined || path === '') && (xml === undefined || xml === '')) {
    return { ok: false, error: 'provide one of path (workspace .drawio file) or xml (inline diagram content)' }
  }
  if (path !== undefined && path !== '' && xml !== undefined && xml !== '') {
    return { ok: false, error: 'provide only one of path or xml, not both' }
  }
  if (xml !== undefined && xml !== '') {
    return { ok: true, content: xml, label: 'inline xml', absPath: '' }
  }
  const abs = resolvePathArg(ctx, path)
  if (abs === '') return { ok: false, error: `cannot resolve path "${path}": no session workspace known; pass an absolute path` }
  const { readFile } = await import('node:fs/promises')
  try {
    const content = await readFile(abs, 'utf8')
    return { ok: true, content, label: abs, absPath: abs }
  } catch (error) {
    return { ok: false, error: `cannot read "${abs}": ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Shared parse step; returns diagrams or a structured failure. */
function parseSource(content: string): { ok: true; diagrams: Diagram[] } | { ok: false; error: string } {
  try {
    const diagrams = parseDiagrams(content)
    return { ok: true, diagrams }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Build the shared result skeleton for a parsed source. */
function baseResult(
  ctx: Context,
  action: string,
  label: string,
  parsed: { ok: true; diagrams: Diagram[] } | { ok: false; error: string },
): DrawioToolResult {
  if (!parsed.ok) {
    return { ok: false, action, source: label, diagrams: 0, vertices: 0, edges: 0, issues: [], files: [], error: parsed.error }
  }
  const issues: string[] = []
  let vertices = 0
  let edges = 0
  for (const diagram of parsed.diagrams) {
    issues.push(...diagram.notes)
    const counts = countCells(diagram)
    vertices += counts.vertices
    edges += counts.edges
  }
  void ctx
  return { ok: true, action, source: label, diagrams: parsed.diagrams.length, vertices, edges, issues, files: [] }
}

/** Write a file next to the source (workspace-gated; skipped when not writable). */
async function writeOutput(ctx: Context, absSource: string, suffix: string, content: string | Uint8Array): Promise<string | null> {
  if (absSource === '') return null
  const base = absSource.replace(/\.(drawio|xml|svg)$/i, '')
  const target = `${base}${suffix}`
  // Only write inside a registered workspace (never arbitrary host paths).
  const gated = await verifyWorkspaceRoot(ctx, dirname(target))
  if (!gated.ok) return null
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
  return target
}

/* ------------------------------------------------------------------ *
 * drawio_validate
 * ------------------------------------------------------------------ */

function validateTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'drawio_validate',
    description: '[dsh-drawio] Validate a drawio diagram: parse a workspace .drawio/.xml file (path) or inline diagram XML (xml) and report diagram/cell/edge counts plus any structural notes. Use before editing an existing diagram or after generating one.',
    parameters: {
      path: { type: 'string', description: 'Absolute or workspace-relative path of a .drawio/.xml file' },
      xml: { type: 'string', description: 'Inline drawio XML (mxfile or mxGraphModel)' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResultText(value as DrawioToolResult) }],
    },
    async execute(args) {
      const { path, xml } = args as { path?: string; xml?: string }
      const source = await resolveSource(ctx, path, xml)
      if (!source.ok) {
        return { ok: false, action: 'validate', source: '', diagrams: 0, vertices: 0, edges: 0, issues: [], files: [], error: source.error }
      }
      const parsed = parseSource(source.content)
      const result = baseResult(ctx, 'validate', source.label, parsed)
      return result
    },
  })
}

/* ------------------------------------------------------------------ *
 * drawio_render
 * ------------------------------------------------------------------ */

function renderTool(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: 'drawio_render',
    description: '[dsh-drawio] Render a drawio diagram to SVG/PNG. Parses a workspace .drawio/.xml file (path) or inline XML (xml), writes <name>.svg (and .png when out includes png) next to the source inside the workspace, and shows a PNG preview inline in the chat. Use after generating or editing a diagram to visualize it.',
    parameters: {
      path: { type: 'string', description: 'Absolute or workspace-relative path of a .drawio/.xml file' },
      xml: { type: 'string', description: 'Inline drawio XML (mxfile or mxGraphModel)' },
      out: { type: 'string', enum: ['svg', 'png', 'both'], description: 'Which files to write (default svg)' },
      preview: { type: 'boolean', description: 'Show a PNG preview inline in the chat (default true)' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => {
        const result = value as DrawioToolResult
        const blocks: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }> = [
          { type: 'text', text: renderResultText(result) },
        ]
        if (result.preview !== undefined) blocks.push({ type: 'image', attachment: result.preview })
        return blocks
      },
    },
    async execute(args) {
      const { path, xml, out, preview } = args as { path?: string; xml?: string; out?: string; preview?: boolean }
      const source = await resolveSource(ctx, path, xml)
      if (!source.ok) {
        return { ok: false, action: 'render', source: '', diagrams: 0, vertices: 0, edges: 0, issues: [], files: [], error: source.error }
      }
      const parsed = parseSource(source.content)
      const result = baseResult(ctx, 'render', source.label, parsed)
      if (!result.ok || !parsed.ok) return result
      const diagram = parsed.diagrams[0]!
      const wantPng = out === 'png' || out === 'both'
      const wantSvg = out === 'svg' || out === 'both' || out === undefined
      const files: string[] = []
      try {
        const svg = diagramToSvg(diagram, { fontFamily: config.fontFamily })
        if (wantSvg) {
          const svgPath = await writeOutput(ctx, source.absPath, '.svg', svg)
          if (svgPath !== null) files.push(svgPath)
        }
        if (wantPng) {
          const { png } = await svgToPng(svg, config.pngScale)
          const pngPath = await writeOutput(ctx, source.absPath, '.png', png)
          if (pngPath !== null) files.push(pngPath)
        }
        broadcastDrawioActivity({ kind: 'render', path: path })
        if (preview !== true) return { ...result, files }
        // Inline chat preview: rasterize once, reuse for the file when png was requested.
        const raster = await svgToPng(svg, config.pngScale)
        if (wantPng) {
          const pngPath = await writeOutput(ctx, source.absPath, '.png', raster.png)
          if (pngPath !== null) files.push(pngPath)
        }
        try {
          const ref = await savePngAttachment(ctx, raster.png, `${diagram.name}.png`)
          return { ...result, files, preview: ref }
        } catch (error) {
          // Attachment store unavailable: degrade to files only, never fail the render.
          return {
            ...result,
            files,
            issues: [...result.issues, `preview unavailable: ${error instanceof Error ? error.message : String(error)}`],
          }
        }
      } catch (error) {
        return {
          ...result,
          ok: false,
          error: `render failed: ${error instanceof Error ? error.message : String(error)}`,
          files,
        }
      }
    },
  })
}

/* ------------------------------------------------------------------ *
 * drawio_edit
 * ------------------------------------------------------------------ */

const EDIT_OP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: {
      type: 'string',
      enum: ['upsert_vertex', 'upsert_edge', 'delete', 'update_style', 'update_value', 'move', 'resize'],
      required: true,
    },
    id: { type: 'string', required: true, description: 'Cell id (e.g. "n1")' },
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
    dx: { type: 'number' },
    dy: { type: 'number' },
    source: { type: 'string' },
    target: { type: 'string' },
    value: { type: 'string' },
    style: { type: 'string' },
    points: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { x: { type: 'number' }, y: { type: 'number' } },
      },
    },
  },
} as const

/** Coerce raw model arguments into EditOp[] (lenient: bad ops become failures). */
function coerceEditOps(raw: unknown): { ops: EditOp[]; errors: string[] } {
  if (!Array.isArray(raw)) return { ops: [], errors: ['ops must be an array'] }
  const ops: EditOp[] = []
  const errors: string[] = []
  const num = (value: unknown, fallback: number): number => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
  const points = (value: unknown): EditPoint[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const out: EditPoint[] = []
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      out.push({ x: num(record.x, 0), y: num(record.y, 0) })
    }
    return out
  }
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      errors.push('an op item is not an object')
      continue
    }
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' && record.id !== '' ? record.id : ''
    switch (record.op) {
      case 'upsert_vertex':
        if (id === '') {
          errors.push('upsert_vertex requires id')
          continue
        }
        ops.push({
          op: 'upsert_vertex',
          id,
          x: num(record.x, 0),
          y: num(record.y, 0),
          w: num(record.w, 120),
          h: num(record.h, 48),
          value: str(record.value),
          style: str(record.style),
        })
        break
      case 'upsert_edge':
        if (id === '' || typeof record.source !== 'string' || typeof record.target !== 'string') {
          errors.push('upsert_edge requires id/source/target')
          continue
        }
        ops.push({
          op: 'upsert_edge',
          id,
          source: record.source,
          target: record.target,
          value: str(record.value),
          style: str(record.style),
          points: points(record.points),
        })
        break
      case 'delete':
        if (id === '') {
          errors.push('delete requires id')
          continue
        }
        ops.push({ op: 'delete', id })
        break
      case 'update_style':
        if (id === '' || typeof record.style !== 'string') {
          errors.push('update_style requires id/style')
          continue
        }
        ops.push({ op: 'update_style', id, style: record.style })
        break
      case 'update_value':
        if (id === '' || typeof record.value !== 'string') {
          errors.push('update_value requires id/value')
          continue
        }
        ops.push({ op: 'update_value', id, value: record.value })
        break
      case 'move':
        if (id === '') {
          errors.push('move requires id')
          continue
        }
        ops.push({ op: 'move', id, dx: num(record.dx, 0), dy: num(record.dy, 0) })
        break
      case 'resize':
        if (id === '') {
          errors.push('resize requires id')
          continue
        }
        ops.push({ op: 'resize', id, w: num(record.w, 0), h: num(record.h, 0) })
        break
      default:
        errors.push(`unknown op: ${String(record.op)}`)
    }
  }
  return { ops, errors }
}

function editTool(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: 'drawio_edit',
    description: '[dsh-drawio] Edit a workspace .drawio/.xml file with structured cell operations — upsert_vertex / upsert_edge / delete / update_style / update_value / move / resize. Pass path plus an ops array (applied in order); the file is rewritten in place and a PNG preview is shown. Never hand-edit mxGraph XML: describe changes as ops. Read the file first to learn its cell ids.',
    parameters: {
      path: { type: 'string', description: 'Absolute or workspace-relative path of the .drawio/.xml file to edit' },
      ops: { type: 'array', items: EDIT_OP_SCHEMA, required: true, description: 'Cell operations, applied in order' },
      preview: { type: 'boolean', description: 'Show a PNG preview inline in the chat (default true)' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => {
        const result = value as DrawioToolResult
        const blocks: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }> = [
          { type: 'text', text: renderResultText(result) },
        ]
        if (result.preview !== undefined) blocks.push({ type: 'image', attachment: result.preview })
        return blocks
      },
    },
    async execute(args) {
      const { path, ops: rawOps, preview } = args as { path?: string; ops?: unknown; preview?: boolean }
      if (typeof path !== 'string' || path === '') {
        return { ok: false, action: 'edit', source: '', diagrams: 0, vertices: 0, edges: 0, issues: [], files: [], error: 'path is required' }
      }
      const source = await resolveSource(ctx, path, undefined)
      if (!source.ok) {
        return { ok: false, action: 'edit', source: path, diagrams: 0, vertices: 0, edges: 0, issues: [], files: [], error: source.error }
      }
      const coerced = coerceEditOps(rawOps)
      if (coerced.ops.length === 0) {
        return {
          ok: false,
          action: 'edit',
          source: source.label,
          diagrams: 0,
          vertices: 0,
          edges: 0,
          issues: [],
          files: [],
          error: `no valid operations: ${coerced.errors.join('; ') || 'empty ops'}`,
        }
      }
      let edited: EditResult
      try {
        edited = applyEditOps(source.content, coerced.ops)
      } catch (error) {
        return {
          ok: false,
          action: 'edit',
          source: source.label,
          diagrams: 0,
          vertices: 0,
          edges: 0,
          issues: [],
          files: [],
          error: `edit failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      const parsed = parseSource(edited.xml)
      const result = baseResult(ctx, 'edit', source.label, parsed)
      result.applied = edited.applied.filter(r => r.ok).length
      result.failed = edited.failed
      const failures = edited.applied.filter(r => !r.ok)
      if (failures.length > 0) {
        result.issues.push(...failures.map(r => `${(r.op as { op: string }).op} ${(r.op as { id?: string }).id ?? ''}: ${r.message ?? 'failed'}`))
      }
      if (!result.ok) {
        return { ...result, error: `edited document is invalid: ${result.error ?? ''}` }
      }
      // Write back (workspace-gated: never rewrite files outside a registered workspace).
      const gated = await verifyWorkspaceRoot(ctx, dirname(source.absPath))
      if (!gated.ok) {
        return { ...result, ok: false, error: `refusing to write outside a registered workspace: ${gated.error}` }
      }
      try {
        await mkdir(dirname(source.absPath), { recursive: true })
        await writeFile(source.absPath, edited.xml, 'utf8')
      } catch (error) {
        return { ...result, ok: false, error: `write failed: ${error instanceof Error ? error.message : String(error)}` }
      }
      result.files.push(source.absPath)
      broadcastDrawioActivity({ kind: 'edit', path: path })
      // Inline preview.
      if (preview !== false && parsed.ok) {
        try {
          const diagram = parsed.diagrams[0]!
          const svg = diagramToSvg(diagram, { fontFamily: config.fontFamily })
          const raster = await svgToPng(svg, config.pngScale)
          const ref = await savePngAttachment(ctx, raster.png, `${diagram.name}.png`)
          result.preview = ref
        } catch (error) {
          result.issues.push(`preview unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return result
    },
  })
}

/* ------------------------------------------------------------------ *
 * drawio_template
 * ------------------------------------------------------------------ */

const KIND_DESCRIPTIONS = {
  flowchart: 'process flow with decision diamonds and orthogonal arrows',
  architecture: 'system architecture: layers of service boxes with grouped containers',
  network: 'network topology: nodes, switches and a router cloud',
  orgchart: 'organization chart: hierarchy of manager/report boxes',
} as const

function templateTool(): ToolDefinition {
  return defineTool({
    name: 'drawio_template',
    description: '[dsh-drawio] Generate a ready-to-edit drawio mxfile skeleton for a common diagram kind. Returns the XML; write it to a .drawio file in the workspace, then use drawio_render to visualize and refine it.',
    parameters: {
      kind: { type: 'string', enum: ['flowchart', 'architecture', 'network', 'orgchart'], description: 'Diagram kind' },
      title: { type: 'string', description: 'Optional diagram name (defaults to the kind)' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResultText(value as DrawioToolResult) }],
    },
    async execute(args) {
      const { kind, title } = args as { kind?: string; title?: string }
      const safeKind = (KIND_DESCRIPTIONS as Record<string, string>)[kind ?? ''] !== undefined ? kind! : 'flowchart'
      const name = typeof title === 'string' && title !== '' ? title : safeKind
      const xml = buildTemplate(safeKind as keyof typeof KIND_DESCRIPTIONS, name)
      broadcastDrawioActivity({ kind: 'template' })
      return {
        ok: true,
        action: 'template',
        source: `template:${safeKind}`,
        diagrams: 1,
        vertices: 0,
        edges: 0,
        issues: [`${KIND_DESCRIPTIONS[safeKind as keyof typeof KIND_DESCRIPTIONS]} — write the XML to a .drawio file, then run drawio_render to see it`],
        files: [],
      }
    },
  })
}

/** One template vertex. */
interface Tv { id: string; x: number; y: number; w: number; h: number; value: string; style: string }
/** One template edge. */
interface Te { id: string; from: string; to: string; value?: string; points?: Array<{ x: number; y: number }> }

const ROUNDED = 'rounded=1;whiteSpace=wrap;html=1;arcSize=12;'
const BOX = 'whiteSpace=wrap;html=1;'

/** Generate a ready-to-edit mxfile for a diagram kind (exported for tests). */
export function buildTemplate(kind: keyof typeof KIND_DESCRIPTIONS, name: string): string {
  let vertices: Tv[] = []
  let edges: Te[] = []
  let n = 0
  const vid = (): string => `cell-${++n}`
  const eid = (): string => `edge-${++n}`

  const layout = (
    rows: Array<Array<{ value: string; style?: string; w?: number; h?: number }>>,
    colGap = 60,
    rowGap = 60,
  ): { vertices: Tv[]; edges: Te[] } => {
    const vs: Tv[] = []
    const es: Te[] = []
    const ids: string[][] = []
    const cellW = 140
    const cellH = 48
    rows.forEach((row, r) => {
      const rowW = row.length * cellW + (row.length - 1) * colGap
      const x0 = 40 + (1200 - rowW) / 2
      const rowIds: string[] = []
      row.forEach((item, c) => {
        const id = vid()
        const w = item.w ?? cellW
        const h = item.h ?? cellH
        const x = x0 + c * (cellW + colGap) + (cellW - w) / 2
        vs.push({ id, x, y: 40 + r * (rowGap + cellH), w, h, value: item.value, style: item.style ?? ROUNDED })
        rowIds.push(id)
      })
      ids.push(rowIds)
    })
    for (let r = 0; r + 1 < ids.length; r += 1) {
      for (const from of ids[r]!) {
        for (const to of ids[r + 1]!) {
          const fromCell = vs.find(v => v.id === from)!
          const toCell = vs.find(v => v.id === to)!
          const fromX = fromCell.x + fromCell.w / 2
          const toX = toCell.x + toCell.w / 2
          const midY = (fromCell.y + fromCell.h + toCell.y) / 2
          es.push({ id: eid(), from, to, points: [{ x: fromX, y: midY }, { x: toX, y: midY }] })
        }
      }
    }
    return { vertices: vs, edges: es }
  }

  switch (kind) {
    case 'flowchart': {
      const rows: Array<Array<{ value: string; style?: string }>> = [
        [{ value: '开始' }],
        [{ value: '获取输入' }],
        [{ value: '条件满足？', style: `rhombus;whiteSpace=wrap;html=1;` }],
        [{ value: '处理 A' }, { value: '处理 B' }],
        [{ value: '结束' }],
      ]
      const built = layout(rows)
      vertices = built.vertices
      edges = built.edges
      break
    }
    case 'architecture': {
      const container = 'rounded=1;whiteSpace=wrap;html=1;arcSize=8;verticalAlign=top;fontStyle=1;'
      const service = 'rounded=1;whiteSpace=wrap;html=1;arcSize=8;'
      vertices = [
        { id: vid(), x: 40, y: 40, w: 1120, h: 210, value: '客户端层', style: `${container}fillColor=#dae8fc;strokeColor=#6c8ebf;` },
        { id: vid(), x: 60, y: 90, w: 200, h: 130, value: 'Web 应用', style: `${service}fillColor=#ffffff;strokeColor=#6c8ebf;` },
        { id: vid(), x: 300, y: 90, w: 200, h: 130, value: '移动端', style: `${service}fillColor=#ffffff;strokeColor=#6c8ebf;` },
        { id: vid(), x: 540, y: 90, w: 200, h: 130, value: '桌面端', style: `${service}fillColor=#ffffff;strokeColor=#6c8ebf;` },
        { id: vid(), x: 40, y: 300, w: 1120, h: 210, value: '服务层', style: `${container}fillColor=#d5e8d4;strokeColor=#82b366;` },
        { id: vid(), x: 60, y: 350, w: 240, h: 130, value: 'API 网关', style: `${service}fillColor=#ffffff;strokeColor=#82b366;` },
        { id: vid(), x: 340, y: 350, w: 240, h: 130, value: '用户服务', style: `${service}fillColor=#ffffff;strokeColor=#82b366;` },
        { id: vid(), x: 620, y: 350, w: 240, h: 130, value: '订单服务', style: `${service}fillColor=#ffffff;strokeColor=#82b366;` },
        { id: vid(), x: 900, y: 350, w: 240, h: 130, value: '支付服务', style: `${service}fillColor=#ffffff;strokeColor=#82b366;` },
        { id: vid(), x: 40, y: 560, w: 1120, h: 170, value: '数据层', style: `${container}fillColor=#ffe6cc;strokeColor=#d79b00;` },
        { id: vid(), x: 60, y: 610, w: 320, h: 90, value: 'MySQL 主库', style: `shape=cylinder3;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#d79b00;` },
        { id: vid(), x: 420, y: 610, w: 320, h: 90, value: 'Redis 缓存', style: `shape=cylinder3;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#d79b00;` },
        { id: vid(), x: 780, y: 610, w: 360, h: 90, value: '对象存储', style: `shape=cylinder3;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#d79b00;` },
      ]
      edges = [
        { id: eid(), from: 'cell-2', to: 'cell-6', points: [{ x: 160, y: 220 }, { x: 160, y: 350 }] },
        { id: eid(), from: 'cell-3', to: 'cell-6', points: [{ x: 400, y: 220 }, { x: 400, y: 350 }] },
        { id: eid(), from: 'cell-4', to: 'cell-6', points: [{ x: 640, y: 220 }, { x: 640, y: 350 }] },
        { id: eid(), from: 'cell-6', to: 'cell-8', points: [{ x: 460, y: 480 }, { x: 460, y: 610 }] },
        { id: eid(), from: 'cell-7', to: 'cell-9', points: [{ x: 740, y: 480 }, { x: 740, y: 610 }] },
        { id: eid(), from: 'cell-8', to: 'cell-11', points: [{ x: 940, y: 480 }, { x: 940, y: 610 }] },
      ]
      break
    }
    case 'network': {
      vertices = [
        { id: vid(), x: 480, y: 20, w: 240, h: 70, value: 'Internet', style: `ellipse;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;` },
        { id: vid(), x: 470, y: 150, w: 260, h: 60, value: '防火墙', style: ROUNDED },
        { id: vid(), x: 100, y: 280, w: 220, h: 60, value: '核心交换机', style: ROUNDED },
        { id: vid(), x: 480, y: 280, w: 240, h: 60, value: '核心交换机', style: ROUNDED },
        { id: vid(), x: 860, y: 280, w: 220, h: 60, value: '核心交换机', style: ROUNDED },
        { id: vid(), x: 60, y: 420, w: 160, h: 120, value: 'Web 服务器', style: BOX },
        { id: vid(), x: 260, y: 420, w: 160, h: 120, value: '应用服务器', style: BOX },
        { id: vid(), x: 460, y: 420, w: 160, h: 120, value: '数据库服务器', style: BOX },
        { id: vid(), x: 660, y: 420, w: 160, h: 120, value: '缓存服务器', style: BOX },
        { id: vid(), x: 860, y: 420, w: 160, h: 120, value: '备份服务器', style: BOX },
      ]
      edges = [
        { id: eid(), from: 'cell-1', to: 'cell-2' },
        { id: eid(), from: 'cell-2', to: 'cell-3' },
        { id: eid(), from: 'cell-2', to: 'cell-4' },
        { id: eid(), from: 'cell-2', to: 'cell-5' },
        { id: eid(), from: 'cell-3', to: 'cell-6' },
        { id: eid(), from: 'cell-3', to: 'cell-7' },
        { id: eid(), from: 'cell-4', to: 'cell-8' },
        { id: eid(), from: 'cell-4', to: 'cell-9' },
        { id: eid(), from: 'cell-5', to: 'cell-10' },
      ]
      break
    }
    case 'orgchart': {
      vertices = [
        { id: vid(), x: 440, y: 40, w: 320, h: 50, value: 'CEO', style: `${BOX}fontStyle=1;` },
        { id: vid(), x: 140, y: 160, w: 240, h: 50, value: '技术 VP', style: BOX },
        { id: vid(), x: 480, y: 160, w: 240, h: 50, value: '产品 VP', style: BOX },
        { id: vid(), x: 820, y: 160, w: 240, h: 50, value: '运营 VP', style: BOX },
        { id: vid(), x: 60, y: 290, w: 180, h: 50, value: '前端组', style: BOX },
        { id: vid(), x: 270, y: 290, w: 180, h: 50, value: '后端组', style: BOX },
        { id: vid(), x: 480, y: 290, w: 180, h: 50, value: '设计组', style: BOX },
        { id: vid(), x: 690, y: 290, w: 180, h: 50, value: '测试组', style: BOX },
        { id: vid(), x: 900, y: 290, w: 180, h: 50, value: '市场组', style: BOX },
      ]
      edges = [
        { id: eid(), from: 'cell-1', to: 'cell-2' },
        { id: eid(), from: 'cell-1', to: 'cell-3' },
        { id: eid(), from: 'cell-1', to: 'cell-4' },
        { id: eid(), from: 'cell-2', to: 'cell-5' },
        { id: eid(), from: 'cell-2', to: 'cell-6' },
        { id: eid(), from: 'cell-3', to: 'cell-7' },
        { id: eid(), from: 'cell-3', to: 'cell-8' },
        { id: eid(), from: 'cell-4', to: 'cell-9' },
      ]
      break
    }
  }

  const cellXml = (v: Tv): string =>
    `      <mxCell id="${v.id}" value="${xmlAttr(v.value)}" style="${v.style}" vertex="1" parent="1"><mxGeometry x="${v.x}" y="${v.y}" width="${v.w}" height="${v.h}" as="geometry"/></mxCell>`
  const edgeXml = (e: Te): string => {
    const points = (e.points ?? []).map(p => `<mxPoint x="${p.x}" y="${p.y}" as="points"/>`).join('')
    const value = e.value === undefined ? '' : ` value="${xmlAttr(e.value)}"`
    const geometry = e.points !== undefined && e.points.length > 0
      ? `<mxGeometry relative="1" as="geometry"><Array as="points">${points}</Array></mxGeometry>`
      : '<mxGeometry relative="1" as="geometry"/>'
    return `      <mxCell id="${e.id}"${value} style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;" edge="1" parent="1" source="${e.from}" target="${e.to}">${geometry}</mxCell>`
  }

  const cells = [...vertices.map(cellXml), ...edges.map(edgeXml)].join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="dsh-drawio" version="0.1.0">
  <diagram id="${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}" name="${xmlAttr(name)}">
    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
${cells}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`
}

/** Escape a value for an XML attribute (template generation). */
function xmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/* ------------------------------------------------------------------ *
 * Text presentation
 * ------------------------------------------------------------------ */

/** Human-readable summary of a tool result (chat text block). */
export function renderResultText(result: DrawioToolResult): string {
  const lines: string[] = []
  if (!result.ok) {
    lines.push(`❌ drawio ${result.action} 失败: ${result.error ?? 'unknown error'}`)
    return lines.join('\n')
  }
  const head: Record<string, string> = {
    validate: '✅ 校验通过',
    render: '✅ 渲染完成',
    template: '✅ 模板已生成',
  }
  lines.push(`${head[result.action] ?? '✅'} · ${result.source}`)
  lines.push(`图 ${result.diagrams} 张 · 节点 ${result.vertices} · 连线 ${result.edges}`)
  for (const issue of result.issues.slice(0, 8)) lines.push(`· ${issue}`)
  if (result.issues.length > 8) lines.push(`· …还有 ${result.issues.length - 8} 条备注`)
  for (const file of result.files) lines.push(`📄 ${file}`)
  if (result.preview !== undefined) lines.push('🖼️ 预览已插入对话（PNG）')
  return lines.join('\n')
}

/** Build the tool set for the resolved config. */
export function buildAgentTools(ctx: Context, config: Config): ToolDefinition[] {
  const out: ToolDefinition[] = []
  if (exposed(config, 'drawio_validate')) out.push(validateTool(ctx))
  if (exposed(config, 'drawio_render')) out.push(renderTool(ctx, config))
  if (exposed(config, 'drawio_edit')) out.push(editTool(ctx, config))
  if (exposed(config, 'drawio_template')) out.push(templateTool())
  return out
}
