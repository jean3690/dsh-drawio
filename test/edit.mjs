/**
 * drawio_edit tests: structured ops on a real flowchart — upsert vertices,
 * edges with waypoints, restyle, relabel, move, delete (with dangling-edge
 * cleanup), then re-render the edited document.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDiagrams, diagramToSvg } from '../lib/index.js'
import { applyEditOps } from '../lib/index.js'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out')
mkdirSync(outDir, { recursive: true })

const BASE = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net">
  <diagram id="flow" name="登录流程">
    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="start" value="开始" style="ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
          <mxGeometry x="480" y="40" width="120" height="40" as="geometry"/>
        </mxCell>
        <mxCell id="check" value="通过？" style="rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="1">
          <mxGeometry x="460" y="260" width="160" height="100" as="geometry"/>
        </mxCell>
        <mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;" edge="1" parent="1" source="start" target="check">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`

const ops = [
  { op: 'upsert_vertex', id: 'step1', x: 460, y: 140, w: 160, h: 50, value: '<b>输入账号</b>', style: 'rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#dae8fc;strokeColor=#6c8ebf;' },
  { op: 'upsert_edge', id: 'e2', source: 'start', target: 'step1', style: 'edgeStyle=orthogonalEdgeStyle;html=1;endArrow=block;' },
  { op: 'upsert_edge', id: 'e3', source: 'step1', target: 'check', points: [{ x: 540, y: 240 }], value: '提交' },
  { op: 'update_style', id: 'check', style: 'rhombus;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;' },
  { op: 'update_value', id: 'start', value: '开始（修订）' },
  { op: 'move', id: 'step1', dx: 40, dy: 10 },
  { op: 'resize', id: 'check', w: 180, h: 120 },
  { op: 'delete', id: 'e1' },
  { op: 'delete', id: 'start' },
  { op: 'upsert_vertex', id: 'start', x: 480, y: 40, w: 120, h: 40, value: '开始', style: 'ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;' },
  { op: 'upsert_edge', id: 'e1', source: 'start', target: 'step1', style: 'edgeStyle=orthogonalEdgeStyle;html=1;endArrow=block;' },
]

const edited = applyEditOps(BASE, ops)
if (edited.failed !== 0) {
  throw new Error(`ops failed: ${JSON.stringify(edited.applied.filter(r => !r.ok))}`)
}
if (edited.applied.length !== ops.length) throw new Error('op count mismatch')

// The edited doc must still parse and render.
const diagrams = parseDiagrams(edited.xml)
const diagram = diagrams[0]
if (diagram.byId.get('step1') === undefined) throw new Error('step1 missing')
if (diagram.byId.get('start') === undefined) throw new Error('start missing after re-upsert')
const edges = [...diagram.byId.values()].filter(c => c.edge)
if (edges.length !== 2) throw new Error(`expected 2 edges after start-delete cleanup, got ${edges.length}`)
if (diagram.byId.get('check')?.style.fillColor !== '#ffe6cc') throw new Error('restyle not applied')
if (diagram.byId.get('start')?.value !== '开始') throw new Error('re-upsert value not applied')
if (diagram.byId.get('step1')?.value !== '<b>输入账号</b>') throw new Error('upsert value not applied')

const svg = diagramToSvg(diagram)
writeFileSync(join(outDir, 'edited.svg'), svg)
// step1 moved by (40,10): abs 500,150 → box top edge at y=150.
if (!svg.includes('L 657 150')) throw new Error('move/resize not reflected in render')

console.log('edited xml ok · vertices:', [...diagram.byId.values()].filter(c => c.vertex).length, '· edges:', edges.length, '· svg:', svg.length, 'bytes')
console.log('EDIT OK')