/**
 * Smoke test: parse a hand-written flowchart mxfile, render SVG, rasterize
 * PNG (resvg), and write both for manual inspection.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDiagrams, diagramToSvg } from '../lib/index.js'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out')
mkdirSync(outDir, { recursive: true })

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net">
  <diagram id="flow" name="登录流程">
    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="start" value="开始" style="ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
          <mxGeometry x="480" y="40" width="120" height="40" as="geometry"/>
        </mxCell>
        <mxCell id="input" value="&lt;b&gt;输入账号密码&lt;/b&gt;" style="rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=13;" vertex="1" parent="1">
          <mxGeometry x="460" y="140" width="160" height="50" as="geometry"/>
        </mxCell>
        <mxCell id="check" value="校验&lt;br&gt;通过？" style="rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="1">
          <mxGeometry x="460" y="260" width="160" height="100" as="geometry"/>
        </mxCell>
        <mxCell id="ok" value="进入首页" style="rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#d5e8d4;strokeColor=#82b366;fontStyle=1;" vertex="1" parent="1">
          <mxGeometry x="700" y="285" width="140" height="50" as="geometry"/>
        </mxCell>
        <mxCell id="err" value="提示错误&lt;font color=&quot;#ff0000&quot;&gt;（重试）&lt;/font&gt;" style="rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#f8cecc;strokeColor=#b85450;" vertex="1" parent="1">
          <mxGeometry x="180" y="285" width="150" height="50" as="geometry"/>
        </mxCell>
        <mxCell id="end" value="结束" style="ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
          <mxGeometry x="700" y="420" width="120" height="40" as="geometry"/>
        </mxCell>
        <mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;strokeColor=#6c8ebf;" edge="1" parent="1" source="start" target="input">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="e2" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;strokeColor=#6c8ebf;" edge="1" parent="1" source="input" target="check">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="e3" value="是" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;fontColor=#82b366;strokeColor=#82b366;exitX=1;exitY=0.5;" edge="1" parent="1" source="check" target="ok">
          <mxGeometry relative="1" as="geometry">
            <Array as="points">
              <mxPoint x="700" y="310"/>
            </Array>
          </mxGeometry>
        </mxCell>
        <mxCell id="e4" value="否" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;fontColor=#b85450;strokeColor=#b85450;exitX=0;exitY=0.5;entryX=1;entryY=0.5;" edge="1" parent="1" source="check" target="err">
          <mxGeometry relative="1" as="geometry">
            <Array as="points">
              <mxPoint x="330" y="310"/>
            </Array>
          </mxGeometry>
        </mxCell>
        <mxCell id="e5" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;curved=1;dashed=1;strokeColor=#b85450;exitX=0;exitY=1;" edge="1" parent="1" source="err" target="input">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="e6" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;strokeColor=#82b366;exitX=0.5;exitY=1;entryX=0.5;entryY=0;" edge="1" parent="1" source="ok" target="end">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`

const diagrams = parseDiagrams(SAMPLE)
const diagram = diagrams[0]
if (diagram.name !== '登录流程') throw new Error('diagram name mismatch')
if (diagram.byId.size < 12) throw new Error(`expected >= 12 cells, got ${diagram.byId.size}`)

const svg = diagramToSvg(diagram)
writeFileSync(join(outDir, 'flowchart.svg'), svg, 'utf8')
console.log('svg bytes:', svg.length)
console.log('viewBox:', /viewBox="([^"]+)"/.exec(svg)?.[1])

// sanity: key marks present (ellipses render as arc paths, rhombus as 4-point polygons)
const marks = [
  ['<svg ', 'root svg'],
  ['A 60 20 0 1 1', 'ellipse arc (start/end)'],
  ['M 540 260 L 620 310', 'rhombus diagonal'],
  ['stroke-dasharray', 'dashed edge'],
  ['fill="#d5e8d4"', 'green fill'],
  ['font-weight="600"', 'bold label'],
  ['<tspan x="654"', 'edge label tspan'],
]
for (const [mark, label] of marks) {
  if (!svg.includes(mark)) throw new Error(`missing expected mark: ${label} (${mark})`)
}

// rasterize
const { svgToPng } = await import('../lib/index.js')
const { png, width, height } = await svgToPng(svg, 2)
writeFileSync(join(outDir, 'flowchart.png'), png)
console.log('png:', width, 'x', height, `${png.length} bytes`)

console.log('SMOKE OK')