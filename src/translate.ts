/**
 * dsh-drawio core translator: diagrams.net (mxfile) XML → SVG.
 *
 * Pure TypeScript, ZERO dependencies, no DOM, no Node built-ins — the exact
 * same module is bundled into the host half (agent tools, PNG rasterization)
 * and the browser half (the 画板 live preview). The renderer covers the
 * drawio feature envelope the agent skill teaches (and the common hand-made
 * subset): rectangles / rounded / ellipse / rhombus / hexagon / triangle /
 * cylinder / swimlane / text shapes, orthogonal & curved edges with explicit
 * waypoints, HTML labels (b/i/u/font/br/span), per-cell styles, groups and
 * edge labels.
 *
 * @module dsh-drawio/translate
 */

/* ------------------------------------------------------------------ *
 * Minimal well-formed XML parser (drawio exports are well-formed).
 * ------------------------------------------------------------------ */

/** One parsed XML element. */
export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** Decoded text content ('' when none). */
  text: string
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
}

/** Decode one XML text/attribute value (named + numeric entities). */
export function decodeXmlEntities(value: string): string {
  if (value.indexOf('&') === -1) return value
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body] ?? match
  })
}

/** A small recursive-descent XML parser: elements, attributes, CDATA, comments, prolog. */
export function parseXml(input: string): XmlNode {
  const src = input.replace(/^\uFEFF/, '')
  let pos = 0

  const error = (message: string): never => {
    const line = src.slice(0, pos).split('\n').length
    throw new Error(`XML parse error at line ${line}: ${message}`)
  }

  const skipMisc = (): void => {
    for (;;) {
      // Inter-element whitespace is insignificant.
      while (pos < src.length && /\s/.test(src[pos] ?? '')) pos += 1
      if (src.startsWith('<?', pos)) {
        const end = src.indexOf('?>', pos + 2)
        if (end === -1) error('unterminated processing instruction')
        pos = end + 2
        continue
      }
      if (src.startsWith('<!--', pos)) {
        const end = src.indexOf('-->', pos + 4)
        if (end === -1) error('unterminated comment')
        pos = end + 3
        continue
      }
      if (src.startsWith('<!DOCTYPE', pos) || src.startsWith('<!doctype', pos)) {
        let depth = 0
        for (;;) {
          const ch = src[pos]
          if (ch === undefined) error('unterminated doctype')
          if (ch === '<') depth += 1
          if (ch === '>' && depth === 1) {
            pos += 1
            break
          }
          if (ch === '>') depth -= 1
          pos += 1
        }
        continue
      }
      break
    }
  }

  const readName = (): string => {
    const start = pos
    while (pos < src.length && /[A-Za-z0-9_:.-]/.test(src[pos] ?? '')) pos += 1
    if (pos === start) error('expected a name')
    return src.slice(start, pos)
  }

  const skipSpace = (): void => {
    while (pos < src.length && /\s/.test(src[pos] ?? '')) pos += 1
  }

  const readAttrs = (): Record<string, string> => {
    const attrs: Record<string, string> = {}
    for (;;) {
      skipSpace()
      const ch = src[pos]
      if (ch === undefined || ch === '>' || ch === '/') return attrs
      const name = readName()
      skipSpace()
      if (src[pos] !== '=') error(`attribute ${name} missing '='`)
      pos += 1
      skipSpace()
      const quote = src[pos]
      if (quote !== '"' && quote !== "'") error(`attribute ${name} missing quote`)
      pos += 1
      const start = pos
      while (pos < src.length && src[pos] !== quote) pos += 1
      if (src[pos] !== quote) error(`unterminated attribute ${name}`)
      attrs[name] = decodeXmlEntities(src.slice(start, pos))
      pos += 1
    }
  }

  const parseElement = (): XmlNode => {
    if (src[pos] !== '<') error('expected element')
    pos += 1
    if (src.startsWith('![CDATA[', pos)) {
      const end = src.indexOf(']]>', pos + 9)
      if (end === -1) error('unterminated CDATA')
      const text = src.slice(pos + 9, end)
      pos = end + 3
      return { name: '#cdata', attrs: {}, children: [], text }
    }
    const name = readName()
    const attrs = readAttrs()
    if (src.startsWith('/>', pos)) {
      pos += 2
      return { name, attrs, children: [], text: '' }
    }
    if (src[pos] !== '>') error(`malformed open tag <${name}>`)
    pos += 1
    const children: XmlNode[] = []
    let text = ''
    for (;;) {
      if (pos >= src.length) error(`unclosed element <${name}>`)
      if (src.startsWith('</', pos)) {
        pos += 2
        const closeName = readName()
        skipSpace()
        if (src[pos] !== '>') error('malformed close tag')
        pos += 1
        if (closeName !== name) error(`mismatched close tag </${closeName}> for <${name}>`)
        return { name, attrs, children, text }
      }
      if (src.startsWith('<![CDATA[', pos)) {
        const node = parseElement()
        children.push(node)
        text += node.text
        continue
      }
      if (src.startsWith('<!--', pos)) {
        const end = src.indexOf('-->', pos + 4)
        if (end === -1) error('unterminated comment')
        pos = end + 3
        continue
      }
      if (src[pos] === '<') {
        children.push(parseElement())
        continue
      }
      const start = pos
      while (pos < src.length && src[pos] !== '<') pos += 1
      text += decodeXmlEntities(src.slice(start, pos))
    }
  }

  skipMisc()
  const root = parseElement()
  skipMisc()
  return root
}

/* ------------------------------------------------------------------ *
 * Diagram model
 * ------------------------------------------------------------------ */

/** A parsed mxGeometry. */
export interface CellGeometry {
  x: number
  y: number
  width: number
  height: number
  relative?: boolean
  /** Edge waypoints (absolute coordinates). */
  points?: Array<{ x: number; y: number }>
  /** Edge label offset (mxPoint as="offset"). */
  offset?: { x: number; y: number }
  /** Edge source/target anchor points (mxPoint as="sourcePoint"/"targetPoint"). */
  sourcePoint?: { x: number; y: number }
  targetPoint?: { x: number; y: number }
}

/** One parsed mxCell. */
export interface Cell {
  id: string
  parentId: string | null
  vertex: boolean
  edge: boolean
  /** Decoded label text ('' when the cell has no label). */
  value: string
  style: Record<string, string>
  geometry: CellGeometry | null
  sourceId: string | null
  targetId: string | null
  collapsed: boolean
  children: Cell[]
}

/** One parsed diagram (mxfile → diagram → mxGraphModel). */
export interface Diagram {
  name: string
  id: string
  background: string | null
  dx: number
  dy: number
  /** Top-level cells (children of the layer cell). */
  cells: Cell[]
  byId: Map<string, Cell>
  /** Non-fatal notes collected while parsing/rendering. */
  notes: string[]
}

/** Split a drawio style string into key/value pairs. */
export function parseStyle(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw === '') return out
  for (const part of raw.split(';')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    if (eq === -1) {
      out[part] = '1'
    } else {
      out[part.slice(0, eq)] = part.slice(eq + 1)
    }
  }
  return out
}

const toNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Index every cell into a flat map; return the renderable cells (all except layer markers). */
function indexDiagram(root: XmlNode, notes: string[]): { cells: Cell[]; byId: Map<string, Cell> } {
  const byId = new Map<string, Cell>()
  const visit = (node: XmlNode, parentId: string | null): Cell | null => {
    if (node.name !== 'mxCell') {
      // Container elements (<root>, <object>, …): descend with the same parent.
      for (const child of node.children) visit(child, parentId)
      return null
    }
    const attrs = node.attrs
    const cell: Cell = {
      id: attrs.id ?? '',
      parentId: attrs.parent ?? parentId,
      vertex: attrs.vertex === '1',
      edge: attrs.edge === '1',
      value: attrs.value === undefined ? '' : decodeXmlEntities(attrs.value),
      style: parseStyle(attrs.style ?? ''),
      geometry: null,
      sourceId: attrs.source ?? null,
      targetId: attrs.target ?? null,
      collapsed: attrs.collapsed === '1',
      children: [],
    }
    for (const child of node.children) {
      if (child.name === 'mxGeometry') {
        const geometry: CellGeometry = {
          x: toNumber(child.attrs.x, 0),
          y: toNumber(child.attrs.y, 0),
          width: toNumber(child.attrs.width, 0),
          height: toNumber(child.attrs.height, 0),
          relative: child.attrs.relative === '1',
        }
        for (const gp of child.children) {
          if (gp.name !== 'mxPoint') continue
          const as = gp.attrs.as
          const point = { x: toNumber(gp.attrs.x, 0), y: toNumber(gp.attrs.y, 0) }
          if (as === 'offset') geometry.offset = point
          else if (as === 'sourcePoint') geometry.sourcePoint = point
          else if (as === 'targetPoint') geometry.targetPoint = point
          else (geometry.points ??= []).push(point)
        }
        cell.geometry = geometry
      } else if (child.name === 'mxCell') {
        const sub = visit(child, cell.id)
        if (sub !== null) cell.children.push(sub)
      }
    }
    if (cell.id === '') {
      notes.push('found a cell without id; skipped')
      return null
    }
    byId.set(cell.id, cell)
    return cell
  }
  for (const child of root.children) visit(child, null)

  // Renderable cells: every cell that is not a layer marker. A layer marker is
  // a cell whose parent is the doc root ('0') or has no parent at all (id "0"
  // and layer cells like id "1").
  const isLayer = (cell: Cell): boolean => cell.parentId === null || cell.parentId === '0' || cell.id === '0'
  const cells = [...byId.values()].filter(cell => !isLayer(cell))
  return { cells, byId }
}

/**
 * Parse a drawio XML document (a full `<mxfile>` document, or a bare
 * `<mxGraphModel>`) into diagrams.
 *
 * @param xml - the file content.
 * @param inflate - optional inflater for compressed mxfiles
 *   (`compressed="true"`, base64 → deflate → utf8). The host passes a
 *   zlib-based inflater; the browser half inflates before calling. Without an
 *   inflater, compressed files produce a descriptive error.
 * @returns the parsed diagrams.
 */
export function parseDiagrams(xml: string, inflate?: (base64: string) => string): Diagram[] {
  const root = parseXml(xml)
  const notes: string[] = []
  if (root.name === 'mxGraphModel') {
    return [buildDiagram(root, 'diagram', '', notes)]
  }
  if (root.name !== 'mxfile') {
    throw new Error(`not a drawio file: expected <mxfile> or <mxGraphModel>, found <${root.name}>`)
  }
  const diagrams: Diagram[] = []
  for (const node of root.children) {
    if (node.name !== 'diagram') continue
    let modelRoot: XmlNode | null = null
    if (root.attrs.compressed === 'true' || root.attrs.compressed === '1') {
      const raw = (node.text + node.children.map(c => c.text).join('')).trim()
      if (raw === '') {
        notes.push('compressed diagram with empty payload; skipped')
        continue
      }
      if (inflate === undefined) {
        throw new Error('compressed drawio file: an inflater is required')
      }
      modelRoot = parseXml(inflate(raw))
    } else {
      modelRoot = findModel(node)
      if (modelRoot === null) {
        notes.push(`diagram "${node.attrs.name ?? ''}" contains no mxGraphModel; skipped`)
        continue
      }
    }
    diagrams.push(buildDiagram(modelRoot, node.attrs.name ?? 'diagram', node.attrs.id ?? '', notes))
  }
  if (diagrams.length === 0) throw new Error('no parseable diagram found in the mxfile')
  return diagrams
}

function findModel(node: XmlNode): XmlNode | null {
  if (node.name === 'mxGraphModel') return node
  for (const child of node.children) {
    const found = findModel(child)
    if (found !== null) return found
  }
  return null
}

function buildDiagram(modelRoot: XmlNode, name: string, id: string, notes: string[]): Diagram {
  const { cells, byId } = indexDiagram(modelRoot, notes)
  const dx = toNumber(modelRoot.attrs.dx, 0)
  const dy = toNumber(modelRoot.attrs.dy, 0)
  const background = modelRoot.attrs.background ?? null
  return { name, id, background, dx, dy, cells, byId, notes }
}

/* ------------------------------------------------------------------ *
 * Geometry resolution
 * ------------------------------------------------------------------ */

/** Absolute geometry of a vertex (parent offsets accumulated). */
export interface AbsRect {
  x: number
  y: number
  width: number
  height: number
}

/** Resolve the absolute rect of a vertex cell, walking parent offsets. */
export function absoluteRect(cell: Cell, diagram: Diagram): AbsRect | null {
  if (!cell.vertex || cell.geometry === null) return null
  let x = cell.geometry.x
  let y = cell.geometry.y
  const w = cell.geometry.width
  const h = cell.geometry.height
  let cursor: Cell | undefined = cell
  let guard = 0
  while (cursor.parentId !== null && cursor.parentId !== undefined && guard < 64) {
    const parent = diagram.byId.get(cursor.parentId)
    if (parent === undefined) break
    if (parent.edge) break
    if (parent.vertex && parent.geometry !== null && !parent.collapsed) {
      x += parent.geometry.x
      y += parent.geometry.y
    }
    cursor = parent
    guard += 1
  }
  return { x, y, width: w, height: h }
}

/* ------------------------------------------------------------------ *
 * Style helpers
 * ------------------------------------------------------------------ */

const stNum = (style: Record<string, string>, key: string, fallback: number): number => {
  const raw = style[key]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

const stStr = (style: Record<string, string>, key: string, fallback: string): string => {
  const raw = style[key]
  return raw === undefined || raw === '' ? fallback : raw
}

/** Font flags: bold=1, italic=2, underline=4. */
export interface FontFace {
  bold: boolean
  italic: boolean
  underline: boolean
  color: string
  size: number
  family: string
}

/** Basic font face from a style map. */
export function fontFromStyle(style: Record<string, string>, family: string): FontFace {
  const flags = stNum(style, 'fontStyle', 0)
  return {
    bold: (flags & 1) !== 0,
    italic: (flags & 2) !== 0,
    underline: (flags & 4) !== 0,
    color: stStr(style, 'fontColor', '#000000'),
    size: stNum(style, 'fontSize', 12),
    family: stStr(style, 'fontFamily', family),
  }
}

/* ------------------------------------------------------------------ *
 * HTML label parsing
 * ------------------------------------------------------------------ */

/** One styled text run. */
export interface TextRun {
  text: string
  bold: boolean
  italic: boolean
  underline: boolean
  color: string
  size: number
}

/**
 * Parse a drawio HTML label (the restricted HTML subset drawio stores:
 * b / i / u / font / br / span style / h1..h6 / p / a) into styled runs,
 * splitting on line breaks.
 */
export function parseHtmlLabel(value: string, base: FontFace): TextRun[][] {
  const lines: TextRun[][] = [[]]
  const stack: Array<Partial<TextRun>> = []
  let current: FontFace = { ...base }

  const pushText = (text: string): void => {
    if (text === '') return
    const run: TextRun = {
      text,
      bold: current.bold,
      italic: current.italic,
      underline: current.underline,
      color: current.color,
      size: current.size,
    }
    const line = lines[lines.length - 1]!
    const prev = line[line.length - 1]
    if (prev !== undefined && prev.bold === run.bold && prev.italic === run.italic
      && prev.underline === run.underline && prev.color === run.color && prev.size === run.size) {
      prev.text += text
    } else {
      line.push(run)
    }
  }
  const newline = (): void => {
    if (lines[lines.length - 1]!.length === 0) lines[lines.length - 1]!.push({ ...current, text: ' ' })
    lines.push([])
  }

  /** Push a style frame; returns the frame to pop on the closing tag. */
  const open = (frame: Partial<TextRun>): void => {
    stack.push(frame)
    if (frame.bold === true) current = { ...current, bold: true }
    if (frame.italic === true) current = { ...current, italic: true }
    if (frame.underline === true) current = { ...current, underline: true }
    if (frame.color !== undefined) current = { ...current, color: frame.color }
    if (frame.size !== undefined) current = { ...current, size: frame.size }
  }
  const close = (): void => {
    const frame = stack.pop()
    if (frame === undefined) return
    if (frame.bold === true) current = { ...current, bold: false }
    if (frame.italic === true) current = { ...current, italic: false }
    if (frame.underline === true) current = { ...current, underline: false }
    if (frame.color !== undefined) current = { ...current, color: base.color }
    if (frame.size !== undefined) current = { ...current, size: base.size }
  }

  let i = 0
  const src = value
  while (i < src.length) {
    const ch = src[i]
    if (ch === '<') {
      const closeIdx = src.indexOf('>', i)
      if (closeIdx === -1) {
        pushText(src.slice(i))
        break
      }
      const tag = src.slice(i + 1, closeIdx)
      const lower = tag.toLowerCase()
      if (lower === 'br' || lower === '/p' || lower === '/div' || lower === '/h1' || lower === '/h2'
        || lower === '/h3' || lower === '/h4' || lower === '/li' || lower === '/tr') {
        newline()
      } else if (lower === 'b' || lower === 'strong') {
        open({ bold: true })
      } else if (lower === 'i' || lower === 'em') {
        open({ italic: true })
      } else if (lower === 'u') {
        open({ underline: true })
      } else if (lower.startsWith('font')) {
        const frame: Partial<TextRun> = {}
        const color = /color\s*=\s*["']?([^"'\s>]+)/i.exec(tag)
        if (color !== null) frame.color = color[1]!
        const size = /size\s*=\s*["']?([0-9]+)/i.exec(tag)
        if (size !== null) {
          const n = Number(size[1])
          if (Number.isFinite(n)) frame.size = n
        }
        open(frame)
      } else if (lower.startsWith('span')) {
        const frame: Partial<TextRun> = {}
        const styleMatch = /style\s*=\s*["']([^"']+)["']/i.exec(tag)
        if (styleMatch !== null) {
          const css = styleMatch[1]!
          if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(css)) frame.bold = true
          if (/font-style\s*:\s*italic/i.test(css)) frame.italic = true
          if (/text-decoration\s*:\s*underline/i.test(css)) frame.underline = true
          const color = /color\s*:\s*(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/i.exec(css)
          if (color !== null) frame.color = color[1]!
          const fontSize = /font-size\s*:\s*([0-9.]+)px/i.exec(css)
          if (fontSize !== null) {
            const n = Number(fontSize[1])
            if (Number.isFinite(n)) frame.size = n
          }
        }
        open(frame)
      } else if (lower.startsWith('a ')) {
        open({})
      } else if (/^h[1-6]$/.test(lower)) {
        const level = Number(lower[1])
        const size = Math.max(10, Math.round(base.size * (level <= 2 ? 1.4 : level === 3 ? 1.2 : 1.05)))
        open({ size, bold: true })
      } else if (lower.startsWith('/b') || lower.startsWith('/strong') || lower.startsWith('/i')
        || lower.startsWith('/em') || lower.startsWith('/u') || lower.startsWith('/font')
        || lower.startsWith('/span') || lower.startsWith('/a') || /^\/h[1-6]$/.test(lower)) {
        close()
      }
      // p/div/ul/ol/li/table/tr/td/img and anything else: no text impact.
      i = closeIdx + 1
      continue
    }
    if (ch === '&') {
      const semi = src.indexOf(';', i)
      if (semi !== -1 && semi - i < 12) {
        pushText(decodeXmlEntities(src.slice(i, semi + 1)))
        i = semi + 1
        continue
      }
    }
    pushText(ch ?? '')
    i += 1
  }
  return lines
}

/* ------------------------------------------------------------------ *
 * Text measurement & wrapping
 * ------------------------------------------------------------------ */

/** Rough advance width of one character in em units (CJK ≈ 1.0, ASCII ≈ 0.55). */
function charAdvance(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  if (code >= 0x20 && code <= 0x7e) return 0.55
  if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff00 && code <= 0xffef)) return 1.0
  if (code >= 0x2000 && code <= 0x206f) return 0.55
  return 0.8
}

/** Wrap one styled line into sub-lines fitting `maxWidth` (px). */
export function wrapRuns(line: TextRun[], maxWidth: number, fontSize: number): TextRun[][] {
  if (maxWidth <= 0 || !Number.isFinite(maxWidth)) return [line]
  const out: TextRun[][] = []
  let currentRow: TextRun[] = []
  let rowWidth = 0
  const flush = (): void => {
    if (currentRow.length > 0) {
      out.push(currentRow)
      currentRow = []
      rowWidth = 0
    }
  }
  for (const run of line) {
    const size = run.size > 0 ? run.size : fontSize
    let seg = ''
    let segWidth = 0
    const flushSeg = (): void => {
      if (seg === '') return
      if (rowWidth + segWidth > maxWidth && rowWidth > 0) flush()
      currentRow.push({ ...run, text: seg })
      rowWidth += segWidth
      seg = ''
      segWidth = 0
    }
    for (const ch of Array.from(run.text)) {
      const w = charAdvance(ch) * size
      if (ch === ' ' && rowWidth + segWidth + w > maxWidth && rowWidth > 0) {
        flushSeg()
        flush()
        continue
      }
      if (rowWidth + segWidth + w > maxWidth && rowWidth + segWidth > 0) {
        flushSeg()
        flush()
      }
      seg += ch
      segWidth += w
    }
    flushSeg()
  }
  flush()
  return out.length > 0 ? out : [line]
}

/** Total advance width of a run list (px). */
export function runWidth(runs: TextRun[], baseSize = 12): number {
  let width = 0
  for (const run of runs) {
    const size = run.size > 0 ? run.size : baseSize
    for (const ch of Array.from(run.text)) width += charAdvance(ch) * size
  }
  return width
}

/** Total line height for a set of wrapped lines (px). */
export function linesHeight(lines: TextRun[][], fontSize: number): number {
  if (lines.length === 0) return fontSize * 1.2
  let height = 0
  for (const line of lines) {
    let size = fontSize
    for (const run of line) {
      if (run.size > 0) size = Math.max(size, run.size)
    }
    height += size * 1.2
  }
  return height
}

/* ------------------------------------------------------------------ *
 * SVG rendering
 * ------------------------------------------------------------------ */

export interface RenderOptions {
  /** Font fallback list (CSS font-family). */
  fontFamily?: string
  /** Padding around the content bounds (default 24). */
  padding?: number
  /** Render the page background color when the model declares one. */
  background?: boolean
}

/** Escape text for XML attribute/text content. */
export function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const svg = (parts: TemplateStringsArray, ...values: Array<string | number>): string =>
  parts.map((part, index) => part + (values[index] ?? '')).join('')

/** One resolved edge (anchor rects + waypoints + label offset). */
interface ResolvedEdge {
  cell: Cell
  points: Array<{ x: number; y: number }>
  labelOffset: { x: number; y: number }
  sourceRect: AbsRect | null
  targetRect: AbsRect | null
}

/**
 * Render one diagram to an SVG document string.
 *
 * @param diagram - parsed diagram.
 * @param options - rendering options.
 * @returns the SVG markup (standalone document with a viewBox).
 */
export function diagramToSvg(diagram: Diagram, options: RenderOptions = {}): string {
  const family = options.fontFamily ?? "Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif"
  const padding = options.padding ?? 24
  const dx = diagram.dx
  const dy = diagram.dy

  // ---- resolve geometry ------------------------------------------------
  const vertices: Array<{ cell: Cell; abs: AbsRect }> = []
  const edges: ResolvedEdge[] = []
  for (const cell of diagram.cells) {
    if (cell.edge) {
      const geom = cell.geometry
      if (geom === null) continue
      let labelOffset = geom.offset ?? { x: 0, y: 0 }
      for (const child of cell.children) {
        if (child.vertex && child.geometry !== null) {
          // drawio edge-label cells carry the label offset in their geometry.
          labelOffset = child.geometry.offset ?? { x: child.geometry.x, y: child.geometry.y }
        }
      }
      edges.push({
        cell,
        points: geom.points ?? [],
        labelOffset,
        sourceRect: cell.sourceId === null ? null : absoluteRectOf(diagram.byId.get(cell.sourceId), diagram),
        targetRect: cell.targetId === null ? null : absoluteRectOf(diagram.byId.get(cell.targetId), diagram),
      })
      continue
    }
    if (!cell.vertex || cell.collapsed) continue
    // Edge label cells render with their edge; skip them here.
    if (cell.parentId !== null && diagram.byId.get(cell.parentId)?.edge === true) continue
    const abs = absoluteRect(cell, diagram)
    if (abs !== null) vertices.push({ cell, abs })
  }

  // ---- content bounds ---------------------------------------------------
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const extend = (x: number, y: number): void => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const { abs } of vertices) {
    extend(abs.x + dx, abs.y + dy)
    extend(abs.x + abs.width + dx, abs.y + abs.height + dy)
  }
  for (const edge of edges) {
    for (const p of edge.points) extend(p.x + dx, p.y + dy)
    const geom = edge.cell.geometry
    if (geom !== null) {
      if (geom.sourcePoint !== undefined) extend(geom.sourcePoint.x + dx, geom.sourcePoint.y + dy)
      if (geom.targetPoint !== undefined) extend(geom.targetPoint.x + dx, geom.targetPoint.y + dy)
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0
    minY = 0
    maxX = 100
    maxY = 100
  }
  // The page origin (dx/dy) shifts BOTH the content and the viewBox: bounds
  // are accumulated in shifted space (see extend calls below) so a non-zero
  // dx/dy can never push content out of the viewport.
  const viewX = minX - padding
  const viewY = minY - padding
  const viewW = maxX - minX + padding * 2
  const viewH = maxY - minY + padding * 2

  const parts: string[] = []
  parts.push(svg`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewX} ${viewY} ${viewW} ${viewH}" font-family="${xmlEscape(family)}">`)

  if (options.background !== false && diagram.background !== null && diagram.background !== 'none' && diagram.background !== '') {
    // Only paint a background for a plain color value. drawio exports theme
    // functions like `light-dark(#fff, #121212)` and gradients
    // (`gradient(...)`), which are not valid SVG paint values — injecting them
    // into fill= would make the browser fall back to default black.
    const bg = diagram.background
    if (/^(#[0-9a-fA-F]{3,8}|rgb\(|rgba\(|hsl\(|hsla\(|[a-zA-Z]+)$/.test(bg)) {
      parts.push(svg`<rect x="${viewX}" y="${viewY}" width="${viewW}" height="${viewH}" fill="${xmlEscape(bg)}"/>`)
    }
  }

  for (const edge of edges) renderEdge(edge, parts, dx, dy, family)
  for (const { cell, abs } of vertices) renderVertex(cell, abs, parts, dx, dy, family)

  parts.push('</svg>')
  return parts.join('')
}

function absoluteRectOf(cell: Cell | undefined, diagram: Diagram): AbsRect | null {
  if (cell === undefined || !cell.vertex) return null
  return absoluteRect(cell, diagram)
}

/* ------------------------------------------------------------------ *
 * Vertex rendering
 * ------------------------------------------------------------------ */

/** Resolve the drawio shape: explicit `shape=` wins; bare style flags follow. */
function resolveShape(style: Record<string, string>): string {
  if (style.shape !== undefined && style.shape !== '') return style.shape
  for (const bare of ['rounded', 'ellipse', 'rhombus', 'hexagon', 'triangle', 'cylinder', 'cylinder3', 'swimlane', 'text', 'image', 'actor', 'process', 'parallelogram', 'cloud'] as const) {
    if (style[bare] === '1') return bare
  }
  return 'rectangle'
}

function renderVertex(cell: Cell, abs: AbsRect, parts: string[], dx: number, dy: number, family: string): void {
  const style = cell.style
  const shape = resolveShape(style)
  const x = abs.x + dx
  const y = abs.y + dy
  const w = abs.width
  const h = abs.height
  const fill = stStr(style, 'fillColor', shape === 'swimlane' ? '#dae8fc' : '#ffffff')
  const stroke = stStr(style, 'strokeColor', '#000000')
  const strokeWidth = stNum(style, 'strokeWidth', 1)
  const opacity = stNum(style, 'opacity', 100)
  const dashed = style.dashed === '1'
  const font = fontFromStyle(style, family)

  const group: string[] = []
  const opacityAttr = opacity < 100 ? ` opacity="${opacity / 100}"` : ''
  const dashAttr = dashed ? ` stroke-dasharray="${Math.max(3, strokeWidth * 2)} ${Math.max(3, strokeWidth * 2)}"` : ''
  const common = (d: string): void => {
    group.push(svg`<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"${opacityAttr}${dashAttr}/>`)
  }

  switch (shape) {
    case 'rounded': {
      const arc = stNum(style, 'arcSize', 10)
      const rx = (arc / 100) * Math.min(w, h) / 2
      common(roundedRectPath(x, y, w, h, rx))
      break
    }
    case 'ellipse':
      common(svg`M ${x + w / 2} ${y} A ${w / 2} ${h / 2} 0 1 1 ${x + w / 2} ${y + h} A ${w / 2} ${h / 2} 0 1 1 ${x + w / 2} ${y} Z`)
      break
    case 'rhombus':
      common(svg`M ${x + w / 2} ${y} L ${x + w} ${y + h / 2} L ${x + w / 2} ${y + h} L ${x} ${y + h / 2} Z`)
      break
    case 'hexagon':
      common(svg`M ${x + w / 2} ${y} L ${x + w} ${y + h * 0.25} L ${x + w} ${y + h * 0.75} L ${x + w / 2} ${y + h} L ${x} ${y + h * 0.75} L ${x} ${y + h * 0.25} Z`)
      break
    case 'triangle':
      common(svg`M ${x + w / 2} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`)
      break
    case 'cylinder':
    case 'cylinder3': {
      const rx = Math.min(w / 2, h * 0.18)
      group.push(svg`<path d="M ${x} ${y + rx} L ${x} ${y + h - rx} A ${w / 2} ${rx} 0 0 0 ${x + w} ${y + h - rx} L ${x + w} ${y + rx} A ${w / 2} ${rx} 0 0 1 ${x} ${y + rx} Z" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"${opacityAttr}${dashAttr}/>`)
      group.push(svg`<ellipse cx="${x + w / 2}" cy="${y + rx}" rx="${w / 2}" ry="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"${opacityAttr}/>`)
      break
    }
    case 'process':
      common(svg`M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`)
      break
    case 'swimlane': {
      const headerH = Math.min(Math.max(stNum(style, 'fontSize', 12) * 2.2, 24), h * 0.55)
      const bodyFill = stStr(style, 'swimlaneFillColor', '#ffffff')
      group.push(svg`<path d="${roundedRectPath(x, y, w, headerH, Math.min(8, w / 2, headerH / 2), false)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`)
      group.push(svg`<path d="M ${x} ${y + headerH} L ${x + w} ${y + headerH} L ${x + w} ${y + h} L ${x} ${y + h} Z" fill="${bodyFill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`)
      if (cell.value !== '') {
        const headerFont = { ...font, bold: true }
        group.push(renderLabelText(cell.value, { x: x + w / 2, y: y + headerH / 2 }, headerFont, 'center', 'middle', w - 8, 0, false))
      }
      break
    }
    case 'text': {
      if (cell.value !== '') {
        const align = stStr(style, 'align', 'center') as 'left' | 'center' | 'right'
        group.push(renderLabelText(cell.value, { x, y: y + stNum(style, 'fontSize', 12) * 0.8 }, font, align, 'top', w, 0, false))
      }
      break
    }
    case 'image': {
      // Placeholder box: data-URI images are not embedded; keep structure visible.
      group.push(svg`<path d="${roundedRectPath(x, y, w, h, 4)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-dasharray="4 3"/>`)
      if (cell.value !== '') {
        const align = stStr(style, 'align', 'center') as 'left' | 'center' | 'right'
        group.push(renderLabelText(cell.value, { x: x + w / 2, y: y + h + 12 }, font, align, 'top', Math.max(120, w), 0, false))
      }
      break
    }
    default: {
      common(svg`M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`)
      break
    }
  }

  // Inside label for box-like shapes.
  if (shape !== 'swimlane' && shape !== 'text' && shape !== 'image' && cell.value !== '') {
    const align = stStr(style, 'align', 'center') as 'left' | 'center' | 'right'
    const valign = stStr(style, 'verticalAlign', 'middle') as 'top' | 'middle' | 'bottom'
    const wrap = style.whiteSpace === 'wrap'
    const spacing = stNum(style, 'spacing', 0)
    const labelPad = Math.max(4, spacing)
    const contentW = Math.max(0, w - labelPad * 2)
    const contentH = Math.max(0, h - labelPad * 2)
    const anchorX = align === 'left' ? x + labelPad : align === 'right' ? x + w - labelPad : x + w / 2
    const anchorY = valign === 'top' ? y + labelPad : valign === 'bottom' ? y + h - labelPad : y + h / 2
    group.push(renderLabelText(cell.value, { x: anchorX, y: anchorY }, font, align, valign, contentW, contentH, wrap))
  }

  if (group.length > 0) parts.push(svg`<g>${group.join('')}</g>`)
}

/** Rounded-rect path (drawio arcSize semantics). */
function roundedRectPath(x: number, y: number, w: number, h: number, rx: number, bottom = true): string {
  const r = Math.max(0, Math.min(rx, w / 2, h / 2))
  if (r === 0) return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`
  if (bottom) {
    return `M ${x + r} ${y} L ${x + w - r} ${y} A ${r} ${r} 0 0 1 ${x + w} ${y + r} L ${x + w} ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} L ${x + r} ${y + h} A ${r} ${r} 0 0 1 ${x} ${y + h - r} L ${x} ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`
  }
  return `M ${x + r} ${y} L ${x + w - r} ${y} A ${r} ${r} 0 0 1 ${x + w} ${y + r} L ${x + w} ${y + h} L ${x} ${y + h} L ${x} ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`
}

/** Render a label (plain or HTML) as one <text> per line, tspans per run. */
function renderLabelText(
  value: string,
  anchor: { x: number; y: number },
  font: FontFace,
  align: 'left' | 'center' | 'right',
  valign: 'top' | 'middle' | 'bottom',
  maxWidth: number,
  maxHeight: number,
  wrap: boolean,
): string {
  void maxHeight
  const rawLines = parseHtmlLabel(value, font)
  const fontSize = font.size
  const textAnchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle'
  const wrapped = wrap ? rawLines.flatMap(line => wrapRuns(line, maxWidth, fontSize)) : rawLines
  const height = linesHeight(wrapped, fontSize)
  let baseY: number
  if (valign === 'top') baseY = anchor.y + fontSize * 0.8
  else if (valign === 'bottom') baseY = anchor.y - (height - fontSize * 0.8)
  else baseY = anchor.y - height / 2 + fontSize * 0.8

  const lines: string[] = []
  let lineY = baseY
  for (const line of wrapped) {
    const width = runWidth(line, fontSize)
    const anchorX = align === 'left' ? anchor.x : align === 'right' ? anchor.x - width : anchor.x - width / 2
    const runs: string[] = []
    let cursor = 0
    let size = fontSize
    for (const run of line) {
      size = run.size > 0 ? run.size : fontSize
      const runStyle = `${run.bold ? ' font-weight="600"' : ''}${run.italic ? ' font-style="italic"' : ''}${run.underline ? ' text-decoration="underline"' : ''}`
      const fill = run.color !== font.color ? ` fill="${xmlEscape(run.color)}"` : ''
      runs.push(svg`<tspan x="${anchorX + cursor}" y="${lineY}" font-size="${run.size > 0 ? run.size : fontSize}"${runStyle}${fill}>${xmlEscape(run.text)}</tspan>`)
      cursor += runWidth([run], fontSize)
    }
    const body = runs.length > 0 ? runs.join('') : svg`<tspan x="${anchorX}" y="${lineY}" font-size="${fontSize}"> </tspan>`
    lines.push(svg`<text text-anchor="${textAnchor}" font-size="${size}" font-family="${xmlEscape(font.family)}">${body}</text>`)
    lineY += size * 1.2
  }
  return lines.join('')
}

/* ------------------------------------------------------------------ *
 * Edge rendering
 * ------------------------------------------------------------------ */

/** Clamp a 0..1 fraction into a rect border point. */
function borderPoint(rect: AbsRect, fx: number, fy: number): { x: number; y: number } {
  const px = rect.x + fx * rect.width
  const py = rect.y + fy * rect.height
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const vx = px - cx
  const vy = py - cy
  if (vx === 0 && vy === 0) return { x: px, y: py }
  const hScale = Math.abs(vx) > 0 ? (rect.width / 2) / Math.abs(vx) : Infinity
  const vScale = Math.abs(vy) > 0 ? (rect.height / 2) / Math.abs(vy) : Infinity
  const scale = Math.min(hScale, vScale)
  return { x: cx + vx * scale, y: cy + vy * scale }
}

/** The side of a rect a border point lies on (for orthogonal routing). */
function pointSide(rect: AbsRect, p: { x: number; y: number }): 'left' | 'right' | 'top' | 'bottom' {
  const dl = p.x - rect.x
  const dr = rect.x + rect.width - p.x
  const dt = p.y - rect.y
  const db = rect.y + rect.height - p.y
  const min = Math.min(dl, dr, dt, db)
  if (min === dl) return 'left'
  if (min === dr) return 'right'
  if (min === dt) return 'top'
  return 'bottom'
}

function renderEdge(edge: ResolvedEdge, parts: string[], dx: number, dy: number, family: string): void {
  const cell = edge.cell
  const style = cell.style
  const geom = cell.geometry
  if (geom === null) return
  const stroke = stStr(style, 'strokeColor', '#000000')
  const strokeWidth = stNum(style, 'strokeWidth', 1)
  const dashed = style.dashed === '1'
  const curved = style.curved === '1'
  const fontSize = stNum(style, 'fontSize', 12)
  const font = fontFromStyle(style, family)

  // ---- anchors -----------------------------------------------------------
  const exitX = stNum(style, 'exitX', -1)
  const exitY = stNum(style, 'exitY', -1)
  const entryX = stNum(style, 'entryX', -1)
  const entryY = stNum(style, 'entryY', -1)
  const exitDx = stNum(style, 'exitDx', 0)
  const exitDy = stNum(style, 'exitDy', 0)
  const entryDx = stNum(style, 'entryDx', 0)
  const entryDy = stNum(style, 'entryDy', 0)

  const computeAnchor = (
    rect: AbsRect | null,
    otherRect: AbsRect | null,
    fx: number,
    fy: number,
    ddx: number,
    ddy: number,
    explicit: { x: number; y: number } | undefined,
  ): { x: number; y: number } | null => {
    if (explicit !== undefined) return explicit
    if (rect === null) return null
    if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) {
      const px = rect.x + fx * rect.width + ddx
      const py = rect.y + fy * rect.height + ddy
      const inside = px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height
      if (!inside) return { x: px, y: py }
      // Interior anchor: project onto the border along the center→point ray.
      return borderPoint(rect, (px - rect.x) / rect.width, (py - rect.y) / rect.height)
    }
    // Default: the border point facing the other endpoint's center.
    if (otherRect !== null) {
      const cx = otherRect.x + otherRect.width / 2
      const cy = otherRect.y + otherRect.height / 2
      return borderPoint(rect, (cx - rect.x) / rect.width, (cy - rect.y) / rect.height)
    }
    return null
  }

  const sourceAnchor = computeAnchor(edge.sourceRect, edge.targetRect, exitX, exitY, exitDx, exitDy, geom.sourcePoint)
  const targetAnchor = computeAnchor(edge.targetRect, edge.sourceRect, entryX, entryY, entryDx, entryDy, geom.targetPoint)
  if (sourceAnchor === null || targetAnchor === null) return

  const shift = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x + dx, y: p.y + dy })

  // ---- polyline -----------------------------------------------------------
  let rawPoints: Array<{ x: number; y: number }>
  const isOrthogonal = style.edgeStyle === 'orthogonalEdgeStyle' || style.edgeStyle === 'elbowEdgeStyle'
  if (edge.points.length > 0) {
    rawPoints = [sourceAnchor, ...edge.points, targetAnchor]
  } else if (isOrthogonal) {
    const exitSide = pointSide(edge.sourceRect ?? { x: sourceAnchor.x, y: sourceAnchor.y, width: 0.01, height: 0.01 }, sourceAnchor)
    const entrySide = pointSide(edge.targetRect ?? { x: targetAnchor.x, y: targetAnchor.y, width: 0.01, height: 0.01 }, targetAnchor)
    void entrySide
    const midX = (sourceAnchor.x + targetAnchor.x) / 2
    const midY = (sourceAnchor.y + targetAnchor.y) / 2
    if (exitSide === 'left' || exitSide === 'right') {
      rawPoints = [sourceAnchor, { x: midX, y: sourceAnchor.y }, { x: midX, y: targetAnchor.y }, targetAnchor]
    } else {
      rawPoints = [sourceAnchor, { x: sourceAnchor.x, y: midY }, { x: targetAnchor.x, y: midY }, targetAnchor]
    }
  } else {
    rawPoints = [sourceAnchor, targetAnchor]
  }
  const points = rawPoints.map(shift)

  const d = curved ? smoothPath(points) : `M ${points.map(p => `${p.x} ${p.y}`).join(' L ')}`
  parts.push(svg`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"${dashed ? ` stroke-dasharray="${Math.max(3, strokeWidth * 2)} ${Math.max(3, strokeWidth * 2)}"` : ''}/>`)

  // ---- arrow markers -------------------------------------------------------
  const endArrow = stStr(style, 'endArrow', 'classic')
  const startArrow = stStr(style, 'startArrow', 'none')
  const endSize = Math.max(6, stNum(style, 'endSize', 10))
  const startSize = Math.max(6, stNum(style, 'startSize', 10))
  if (endArrow !== 'none' && endArrow !== '') {
    const marker = markerPath(points, true, endArrow, endSize, stroke, strokeWidth, stStr(style, 'endFill', '1') === '1')
    if (marker !== '') parts.push(marker)
  }
  if (startArrow !== 'none' && startArrow !== '') {
    const marker = markerPath(points, false, startArrow, startSize, stroke, strokeWidth, stStr(style, 'startFill', '1') === '1')
    if (marker !== '') parts.push(marker)
  }

  // ---- label -----------------------------------------------------------------
  if (cell.value !== '') {
    const midIndex = Math.floor((points.length - 1) / 2)
    const a = points[midIndex] ?? points[0]!
    const b = points[Math.min(midIndex + 1, points.length - 1)] ?? a
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const labelX = mid.x + edge.labelOffset.x
    const labelY = mid.y + edge.labelOffset.y
    const bg = stStr(style, 'labelBackgroundColor', '')
    const align = stStr(style, 'align', 'center') as 'left' | 'center' | 'right'
    const width = runWidth(parseHtmlLabel(cell.value, font).flat(), fontSize)
    if (bg !== '') {
      parts.push(svg`<rect x="${labelX - width / 2 - 3}" y="${labelY - fontSize * 0.6}" width="${width + 6}" height="${fontSize * 1.4}" fill="${xmlEscape(bg)}" stroke="none"/>`)
    }
    parts.push(renderLabelText(cell.value, { x: labelX, y: labelY }, font, align, 'middle', 2000, 0, false))
  }
}

/** Smooth quadratic path through all points (drawio `curved=1` look). */
function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`
  if (points.length === 2) return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`
  let d = `M ${points[0]!.x} ${points[0]!.y} Q ${points[1]!.x} ${points[1]!.y} ${points[2]!.x} ${points[2]!.y}`
  for (let i = 3; i < points.length; i += 1) {
    const p = points[i]!
    d += ` T ${p.x} ${p.y}`
  }
  return d
}

/** One arrowhead at the start or end of a polyline. */
function markerPath(
  points: Array<{ x: number; y: number }>,
  atEnd: boolean,
  kind: string,
  size: number,
  stroke: string,
  strokeWidth: number,
  filled: boolean,
): string {
  if (points.length < 2) return ''
  const tip = atEnd ? points[points.length - 1]! : points[0]!
  const prev = atEnd ? points[points.length - 2]! : points[1]!
  const dx = tip.x - prev.x
  const dy = tip.y - prev.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return ''
  const ux = dx / len
  const uy = dy / len
  // Direction pointing BACK into the edge from the tip.
  const nx = atEnd ? -ux : ux
  const ny = atEnd ? -uy : uy
  const px = -ny
  const py = nx
  const L = size

  const backX = tip.x + nx * L
  const backY = tip.y + ny * L

  switch (kind) {
    case 'classic': {
      const half = L * 0.45
      const base = L * 0.55
      const p1 = { x: backX + px * half, y: backY + py * half }
      const p2 = { x: backX - px * half, y: backY - py * half }
      const crossX = tip.x + nx * (base * 0.45)
      const crossY = tip.y + ny * (base * 0.45)
      const fillAttr = filled ? ` fill="${stroke}"` : ' fill="none"'
      return `<g>${svg`<path d="M ${p1.x} ${p1.y} L ${tip.x} ${tip.y} L ${p2.x} ${p2.y}"${fillAttr} stroke="${stroke}" stroke-width="${strokeWidth}"/>`}${svg`<path d="M ${crossX + px * half * 0.7} ${crossY + py * half * 0.7} L ${crossX - px * half * 0.7} ${crossY - py * half * 0.7}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`}</g>`
    }
    case 'block': {
      const half = L * 0.4
      const fillAttr = filled ? ` fill="${stroke}"` : ' fill="none"'
      return svg`<path d="M ${tip.x} ${tip.y} L ${backX + px * half} ${backY + py * half} L ${backX - px * half} ${backY - py * half} Z"${fillAttr} stroke="${stroke}" stroke-width="${strokeWidth}"/>`
    }
    case 'open': {
      const half = L * 0.45
      const base = L * 0.6
      const bx = tip.x + nx * base
      const by = tip.y + ny * base
      return svg`<path d="M ${bx + px * half} ${by + py * half} L ${tip.x} ${tip.y} L ${bx - px * half} ${by - py * half}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
    }
    case 'oval': {
      const r = L * 0.5
      return svg`<circle cx="${tip.x}" cy="${tip.y}" r="${r}" fill="${filled ? stroke : 'none'}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
    }
    case 'diamond': {
      const half = L * 0.45
      const base = L * 0.55
      const sideX = tip.x + nx * (base / 2)
      const sideY = tip.y + ny * (base / 2)
      return svg`<path d="M ${tip.x} ${tip.y} L ${sideX + px * half} ${sideY + py * half} L ${backX} ${backY} L ${sideX - px * half} ${sideY - py * half} Z" fill="${filled ? stroke : 'none'}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
    }
    default:
      return ''
  }
}
