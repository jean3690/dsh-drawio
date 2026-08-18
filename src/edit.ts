/**
 * Structured diagram editing: apply cell-level operations to a drawio
 * document and re-serialize it. The agent describes WHAT to change
 * (upsert/delete/move/restyle a cell), not raw XML surgery — the model never
 * hand-edits mxGraph XML, so structure cannot break.
 *
 * The operations work on the parsed XML tree (from translate.ts), so unknown
 * elements/attributes round-trip untouched.
 *
 * @module dsh-drawio/edit
 */

import { parseXml, type XmlNode } from './translate.ts'

/** One geometry/point pair. */
export interface EditPoint {
  x: number
  y: number
}

/** A cell-level edit operation. */
export type EditOp =
  | { op: 'upsert_vertex'; id: string; x: number; y: number; w: number; h: number; value?: string; style?: string }
  | { op: 'upsert_edge'; id: string; source: string; target: string; value?: string; style?: string; points?: EditPoint[] }
  | { op: 'delete'; id: string }
  | { op: 'update_style'; id: string; style: string }
  | { op: 'update_value'; id: string; value: string }
  | { op: 'move'; id: string; dx: number; dy: number }
  | { op: 'resize'; id: string; w: number; h: number }

/** The outcome of applying one op. */
export interface EditOpResult {
  op: EditOp
  ok: boolean
  message?: string
}

/** The outcome of an edit pass. */
export interface EditResult {
  xml: string
  applied: EditOpResult[]
  failed: number
}

const num = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Serialize one XML node back to markup (attribute order preserved). */
export function serializeXml(node: XmlNode): string {
  if (node.name === '#cdata') return `<![CDATA[${node.text}]]>`
  const attrs = Object.entries(node.attrs)
    .map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
    .join('')
  if (node.children.length === 0 && node.text === '') return `<${node.name}${attrs}/>`
  const body = node.children.map(serializeXml).join('') + escapeText(node.text)
  return `<${node.name}${attrs}>${body}</${node.name}>`
}

function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Find the mxfile root (or wrap a bare mxGraphModel). */
function locateModel(root: XmlNode): { model: XmlNode; layer: XmlNode | null } {
  const find = (node: XmlNode): XmlNode | null => {
    if (node.name === 'mxGraphModel') return node
    for (const child of node.children) {
      const found = find(child)
      if (found !== null) return found
    }
    return null
  }
  const model = find(root)
  if (model === null) throw new Error('no mxGraphModel found in the document')
  // The layer cell: an mxCell with parent="0" (usually id="1") under <root>.
  const rootEl = model.children.find((child) => child.name === 'root')
  let layer: XmlNode | null = null
  if (rootEl !== undefined) {
    for (const child of rootEl.children) {
      if (child.name === 'mxCell' && (child.attrs.parent === '0' || child.attrs.id === '1')) {
        layer = child
        break
      }
    }
  }
  return { model, layer }
}

/** Find an mxCell by id anywhere under the model. */
function findCell(model: XmlNode, id: string): XmlNode | null {
  const walk = (node: XmlNode): XmlNode | null => {
    if (node.name === 'mxCell' && node.attrs.id === id) return node
    for (const child of node.children) {
      const found = walk(child)
      if (found !== null) return found
    }
    return null
  }
  return walk(model)
}

/** Build a vertex/edge mxCell node with a structured geometry child. */
function buildCell(attrs: Record<string, string>, geometry: XmlNode, children: XmlNode[] = []): XmlNode {
  return {
    name: 'mxCell',
    attrs,
    children: [...children, geometry],
    text: '',
  }
}

/** Structured geometry node for a vertex. */
function vertexGeometry(x: number, y: number, w: number, h: number): XmlNode {
  return {
    name: 'mxGeometry',
    attrs: { x: String(x), y: String(y), width: String(w), height: String(h), as: 'geometry' },
    children: [],
    text: '',
  }
}

/** Structured geometry node for an edge (waypoints). */
function edgeGeometry(points: EditPoint[]): XmlNode {
  return {
    name: 'mxGeometry',
    attrs: { relative: '1', as: 'geometry' },
    children: points.length === 0
      ? []
      : [{
          name: 'Array',
          attrs: { as: 'points' },
          children: points.map((p) => ({ name: 'mxPoint', attrs: { x: String(p.x), y: String(p.y) }, children: [], text: '' })),
          text: '',
        }],
    text: '',
  }
}

/**
 * Apply one op to the model tree. Returns the result; mutates `model`.
 */
function applyOp(model: XmlNode, layer: XmlNode | null, op: EditOp): EditOpResult {
  switch (op.op) {
    case 'upsert_vertex': {
      const existing = findCell(model, op.id)
      if (existing !== null) {
        // Update geometry + value + style in place.
        const geom = existing.children.find((child) => child.name === 'mxGeometry')
        if (geom !== undefined) {
          geom.attrs.x = String(num(op.x, Number(geom.attrs.x ?? 0)))
          geom.attrs.y = String(num(op.y, Number(geom.attrs.y ?? 0)))
          geom.attrs.width = String(num(op.w, Number(geom.attrs.width ?? 0)))
          geom.attrs.height = String(num(op.h, Number(geom.attrs.height ?? 0)))
        }
        if (op.value !== undefined) existing.attrs.value = op.value
        if (op.style !== undefined) existing.attrs.style = op.style
        return { op, ok: true, message: `updated vertex ${op.id}` }
      }
      if (layer === null) return { op, ok: false, message: 'no layer cell to attach to' }
      const cell = buildCell(
        {
          id: op.id,
          parent: layer.attrs.id ?? '1',
          ...(op.value === undefined ? {} : { value: op.value }),
          style: op.style ?? 'rounded=1;whiteSpace=wrap;html=1;arcSize=12;',
          vertex: '1',
        },
        vertexGeometry(op.x, op.y, op.w, op.h),
      )
      layer.children.push(cell)
      return { op, ok: true, message: `created vertex ${op.id}` }
    }
    case 'upsert_edge': {
      const existing = findCell(model, op.id)
      if (existing !== null) {
        if (op.source !== undefined) existing.attrs.source = op.source
        if (op.target !== undefined) existing.attrs.target = op.target
        if (op.value !== undefined) existing.attrs.value = op.value
        if (op.style !== undefined) existing.attrs.style = op.style
        if (op.points !== undefined) {
          const geom = existing.children.find((child) => child.name === 'mxGeometry')
          if (geom !== undefined) {
            geom.children = geom.children.filter((child) => child.name !== 'Array')
            if (op.points.length > 0) {
              geom.children.push({
                name: 'Array',
                attrs: { as: 'points' },
                children: op.points.map((p) => ({ name: 'mxPoint', attrs: { x: String(p.x), y: String(p.y) }, children: [], text: '' })),
                text: '',
              })
            }
          }
        }
        return { op, ok: true, message: `updated edge ${op.id}` }
      }
      if (layer === null) return { op, ok: false, message: 'no layer cell to attach to' }
      const cell = buildCell(
        {
          id: op.id,
          parent: layer.attrs.id ?? '1',
          ...(op.value === undefined ? {} : { value: op.value }),
          style: op.style ?? 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;',
          edge: '1',
          source: op.source,
          target: op.target,
        },
        edgeGeometry(op.points ?? []),
      )
      layer.children.push(cell)
      return { op, ok: true, message: `created edge ${op.id}` }
    }
    case 'delete': {
      const walk = (node: XmlNode): boolean => {
        const index = node.children.findIndex((child) => child.name === 'mxCell' && child.attrs.id === op.id)
        if (index !== -1) {
          node.children.splice(index, 1)
          return true
        }
        for (const child of node.children) {
          if (walk(child)) return true
        }
        return false
      }
      const removed = walk(model)
      // Drop edges that referenced the deleted cell.
      const dropRefs = (node: XmlNode): void => {
        for (const child of node.children) {
          if (child.name === 'mxCell' && (child.attrs.source === op.id || child.attrs.target === op.id)) {
            node.children.splice(node.children.indexOf(child), 1)
            continue
          }
          dropRefs(child)
        }
      }
      dropRefs(model)
      return removed
        ? { op, ok: true, message: `deleted ${op.id}` }
        : { op, ok: false, message: `no cell with id ${op.id}` }
    }
    case 'update_style': {
      const cell = findCell(model, op.id)
      if (cell === null) return { op, ok: false, message: `no cell with id ${op.id}` }
      cell.attrs.style = op.style
      return { op, ok: true, message: `restyled ${op.id}` }
    }
    case 'update_value': {
      const cell = findCell(model, op.id)
      if (cell === null) return { op, ok: false, message: `no cell with id ${op.id}` }
      if (cell.attrs.value === undefined) {
        // A cell without a value attribute: add it (labels live in `value`).
        cell.attrs.value = op.value
      } else {
        cell.attrs.value = op.value
      }
      return { op, ok: true, message: `relabelled ${op.id}` }
    }
    case 'move': {
      const cell = findCell(model, op.id)
      if (cell === null) return { op, ok: false, message: `no cell with id ${op.id}` }
      const geom = cell.children.find((child) => child.name === 'mxGeometry')
      if (geom === undefined) return { op, ok: false, message: `${op.id} has no geometry` }
      geom.attrs.x = String(num(geom.attrs.x, 0) + num(op.dx, 0))
      geom.attrs.y = String(num(geom.attrs.y, 0) + num(op.dy, 0))
      return { op, ok: true, message: `moved ${op.id}` }
    }
    case 'resize': {
      const cell = findCell(model, op.id)
      if (cell === null) return { op, ok: false, message: `no cell with id ${op.id}` }
      const geom = cell.children.find((child) => child.name === 'mxGeometry')
      if (geom === undefined) return { op, ok: false, message: `${op.id} has no geometry` }
      geom.attrs.width = String(num(op.w, Number(geom.attrs.width ?? 0)))
      geom.attrs.height = String(num(op.h, Number(geom.attrs.height ?? 0)))
      return { op, ok: true, message: `resized ${op.id}` }
    }
  }
}

/**
 * Apply a list of operations to a drawio document.
 *
 * @param xml - the .drawio/.xml file content.
 * @param ops - the cell-level operations (applied in order).
 * @returns the edited document plus per-op results.
 */
export function applyEditOps(xml: string, ops: EditOp[]): EditResult {
  if (ops.length === 0) throw new Error('no operations provided')
  const root = parseXml(xml)
  const { model, layer } = locateModel(root)
  const applied: EditOpResult[] = []
  for (const op of ops) {
    applied.push(applyOp(model, layer, op))
  }
  return {
    xml: serializeXml(root),
    applied,
    failed: applied.filter((result) => !result.ok).length,
  }
}