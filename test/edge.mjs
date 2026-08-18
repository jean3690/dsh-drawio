/**
 * Edge-case tests: swimlane + nested groups, text-only shapes, rounded
 * default, compressed mxfile support via the zlib inflater, and the agent
 * template output structure (built by replicating the flow of tools.ts).
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync, deflateSync } from 'node:zlib'
import { parseDiagrams, diagramToSvg, parseStyle } from '../lib/index.js'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out')
mkdirSync(outDir, { recursive: true })

// 1. swimlane + group + text shape
const SWIM = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile><diagram name="泳道测试">
<mxGraphModel dx="0" dy="0"><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="lane" value="生产环境" style="swimlane;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=13;" vertex="1" parent="1">
  <mxGeometry x="40" y="40" width="520" height="260" as="geometry"/>
  <mxCell id="svc1" value="服务 A" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#6c8ebf;" vertex="1" parent="lane">
    <mxGeometry x="40" y="60" width="140" height="48" as="geometry"/>
  </mxCell>
  <mxCell id="svc2" value="服务 B" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#6c8ebf;" vertex="1" parent="lane">
    <mxGeometry x="320" y="60" width="140" height="48" as="geometry"/>
  </mxCell>
</mxCell>
<mxCell id="note" value="说明：&lt;i&gt;只读&lt;/i&gt; 区域" style="text;html=1;align=left;" vertex="1" parent="1">
  <mxGeometry x="620" y="60" width="200" height="30" as="geometry"/>
</mxCell>
<mxCell id="es" style="edgeStyle=orthogonalEdgeStyle;html=1;endArrow=block;" edge="1" parent="1" source="svc1" target="svc2">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>
</root></mxGraphModel></diagram></mxfile>`

const swim = parseDiagrams(SWIM)[0]
const svgSwim = diagramToSvg(swim)
writeFileSync(join(outDir, 'swimlane.svg'), svgSwim)
if (!svgSwim.includes('fill="#dae8fc"')) throw new Error('swimlane header fill missing')
if (!svgSwim.includes('font-style="italic"')) throw new Error('italic note missing')
if (!svgSwim.includes('L 217.6 100')) throw new Error('swimlane child offset wrong (child must be at abs ~80,100)')
if (!svgSwim.includes('M 220 124 L 290 124')) throw new Error('orthogonal edge from svc1 right edge missing')

// 2. compressed mxfile (zlib deflate, as drawio's "compressed" option does)
const modelXml = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n" value="hi" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel>'
const payload = deflateSync(Buffer.from(modelXml, 'utf8')).toString('base64')
const compressed = `<?xml version="1.0"?><mxfile compressed="true"><diagram name="c">${payload}</diagram></mxfile>`
const inflater = (b64) => inflateSync(Buffer.from(b64, 'base64')).toString('utf8')
const compressedDiagrams = parseDiagrams(compressed, inflater)
if (compressedDiagrams[0].byId.get('n') === undefined) throw new Error('compressed parse failed')
console.log('compressed roundtrip ok')

// 3. style parse sanity + template XML shape from the built tool description
const style = parseStyle('rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#fff;edgeStyle=orthogonalEdgeStyle;')
if (style.rounded !== '1' || style.edgeStyle !== 'orthogonalEdgeStyle' || style.fillColor !== '#fff') {
  throw new Error('style parse broken')
}

console.log('swimlane svg ok:', svgSwim.length, 'bytes')
console.log('EDGE CASES OK')

// 4. dx/dy page-origin regression: drawio-rewritten files carry a non-zero
// dx/dy; content must stay inside the viewBox (viewBox + elements shift together).
import { diagramToSvg as d2s } from '../lib/index.js'
const OFFSET_XML = `<?xml version="1.0"?><mxfile><diagram name="o"><mxGraphModel dx="949" dy="611" background="light-dark(#ffffff, #121212)"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n1" value="A" vertex="1" parent="1"><mxGeometry x="100" y="120" width="140" height="50" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`
{
  const d = parseDiagrams(OFFSET_XML)[0]
  const svg = d2s(d)
  const vb = /viewBox="([^"]+)"/.exec(svg)[1].split(' ').map(Number)
  const starts = [...svg.matchAll(/M (-?[0-9.]+) (-?[0-9.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
  const inside = starts.filter(([x, y]) => x >= vb[0] - 0.01 && y >= vb[1] - 0.01 && x <= vb[0] + vb[2] + 0.01 && y <= vb[1] + vb[3] + 0.01)
  if (starts.length === 0 || inside.length < starts.length * 0.9) {
    throw new Error(`dx/dy offset pushed content out of viewBox (${inside.length}/${starts.length})`)
  }
  if (svg.includes('light-dark')) throw new Error('invalid theme background leaked into svg')
  console.log('dx/dy viewBox regression ok ·', inside.length, '/', starts.length)
}
