---
name: drawio
description: "Drawio/diagrams.net diagram creation and edit. Trigger when the user asks to 画图/画流程图/画架构图/画网络拓扑/画时序相关图表, or asks to create or modify a .drawio file, or to visualize something as a diagram. Use the drawio_* tools: drawio_template to scaffold, drawio_edit to change an existing diagram (structured ops — never hand-edit XML), drawio_render to visualize, drawio_validate to check XML. The renderer covers a specific feature envelope — stay inside it (see the XML conventions below) so every rendered diagram looks right."
---

# Drawio — 画图规范

本插件把 diagrams.net（drawio）当作 agent 的一等公民：你写 mxGraph XML，`drawio_render` 立刻把它渲染成 SVG/PNG 并在对话中显示；用户可在右侧「Drawio 画板」里用**官方 drawio 编辑器**打开同一个文件继续精修。**绘制任何图都走这个流水线**：

```
画新图:   drawio_template(kind)  →  写到工作区 <name>.drawio  →  drawio_render(path)
改旧图:   read 现有 .drawio（记下 cell id）  →  drawio_edit(path, ops)  →  画板/编辑器自动同步
```

## 工作流（必须遵守）

1. **画新图**：先判断图型（flowchart / architecture / network / orgchart），用 `drawio_template` 骨架起步，不要手搓 XML 大图。
2. **改旧图**：**永远用 `drawio_edit` 的结构化 ops 改图，绝不手写/正则替换 mxGraph XML**。步骤：先 read 文件了解现有 cell 的 id 与布局 → 用 ops 描述改动（增节点 `upsert_vertex`、增连线 `upsert_edge`、删 `delete`、改样式 `update_style`、改标签 `update_value`、移动 `move`、缩放 `resize`）→ 一次调用完成。
3. **落盘**：`.drawio` 文件写入工作区（`docs/` 或项目根），小写扩展名。
4. **可视化确认**：`drawio_render`（或 `drawio_edit` 自带预览）把图贴进对话给用户确认。用户说「再加/改成/删掉 X」时，重复第 2 步，改完必须重新渲染给用户看。
5. 连线尽量给显式 `points`（见下），保证渲染和 drawio 编辑器一致。

## drawio_edit ops 速查

- `upsert_vertex`: `{op, id, x, y, w, h, value?, style?}` — 有则更新几何/标签/样式，无则新建（默认样式圆角矩形）
- `upsert_edge`: `{op, id, source, target, value?, style?, points?: [{x,y}]}` — 新建/更新连线；默认 `edgeStyle=orthogonalEdgeStyle;endArrow=block`
- `delete`: `{op, id}` — 删除节点/连线；引用它的连线自动清理
- `update_style` / `update_value` / `move` / `resize`: 按 id 改样式/标签/平移/缩放
- 常用 id 命名：`n1` `n2`…、`e1` `e2`…；一个文件内唯一。

## XML 骨架（最小合法文件）

```xml
<mxfile host="dsh-drawio" version="1">
  <diagram id="arch" name="架构图">
    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <!-- 所有节点/连线的父都是 id="1" -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

- 全文件一个 `<diagram>`；`dx`/`dy` 保持 0。
- 每个 cell 必须有唯一 `id`（如 `n1`、`e1`）。
- 节点：`vertex="1" parent="1"`；连线：`edge="1" parent="1" source="<节点id>" target="<节点id>"`。
- 坐标画在 1169×827 页内，节点间至少留 40px 空隙。

## 节点样式（渲染器支持全集）

`style="key=value;key=value;…"`，支持：

| 用途 | style 片段 |
|---|---|
| 圆角矩形（默认） | `rounded=1;whiteSpace=wrap;html=1;arcSize=12;` |
| 直角矩形 | `whiteSpace=wrap;html=1;` |
| 菱形（判断） | `rhombus;whiteSpace=wrap;html=1;` |
| 椭圆（起止） | `ellipse;whiteSpace=wrap;html=1;` |
| 六边形 | `hexagon;whiteSpace=wrap;html=1;` |
| 三角形 | `triangle;whiteSpace=wrap;html=1;` |
| 圆柱（数据库） | `shape=cylinder3;whiteSpace=wrap;html=1;` |
| 泳道/容器 | `swimlane;whiteSpace=wrap;html=1;verticalAlign=top;`（子节点坐标相对容器） |
| 纯文本 | `text;html=1;align=center;` |

通用：`fillColor=#dae8fc` 填色、`strokeColor=#6c8ebf` 描边、`strokeWidth=2` 线宽、`dashed=1` 虚线、`fontSize=13`、`fontColor=#333333`、`fontStyle=1`（粗体，2 斜体，4 下划线）、`align=center|left|right`、`verticalAlign=middle|top|bottom`。

几何：`<mxGeometry x="40" y="80" width="140" height="48" as="geometry"/>`。**标签写在 cell 的 `value` 属性里**，支持内联 HTML：`<b>粗体</b>`、`<i>斜体</i>`、`<font color="#ff0000">红字</font>`、`<br>` 换行、`<span style="...">`。长文本加 `whiteSpace=wrap` 自动换行。

## 连线样式

```xml
<mxCell id="e1" value="标签" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;" edge="1" parent="1" source="n1" target="n2">
  <mxGeometry relative="1" as="geometry">
    <Array as="points">
      <mxPoint x="210" y="150"/>
      <mxPoint x="210" y="240"/>
    </Array>
  </mxGeometry>
</mxCell>
```

- **强烈建议给拐弯的边写显式 `points`（绝对坐标）**——渲染器和 drawio 都按此布线；不写 points 时默认直线。
- 箭头：`endArrow=classic`（默认，开箭头）、`block`（实心三角）、`open`、`none`；`startArrow=none`。虚线：`dashed=1`。
- 锚点：`exitX=0.5;exitY=1;`（从源节点底部出）、`entryX=0.5;entryY=0;`（进目标顶部），值域 0~1。
- 边标签：优先写边的 `value`；需要偏移位置时把标签做成父为该边的 vertex cell，geometry 里用 `<mxPoint x="12" y="-18" as="offset"/>`。

## 常见配色（参考 drawio 色板）

- 蓝系：`fillColor=#dae8fc;strokeColor=#6c8ebf`
- 绿系：`fillColor=#d5e8d4;strokeColor=#82b366`
- 橙系：`fillColor=#ffe6cc;strokeColor=#d79b00`
- 紫系：`fillColor=#e1d5e7;strokeColor=#9673a6`
- 红系：`fillColor=#f8cecc;strokeColor=#b85450`

## 渲染器未覆盖的能力（会退化为占位，避免使用）

- `shape=image`（嵌入图片）：渲染为虚线框 + 标签。
- 复杂表格（`shape=table`）与 UML 专用形状（actor/umlLifeline 等）：只用基础形状组合表达。
- 压缩格式 mxfile（`compressed="true"`）：能读，但生成时一律输出未压缩格式。

## 画板联动

用户可在右侧面板「Drawio 画板」里打开、编辑、保存工作区 .drawio 文件并导出 PNG。你生成的图要紧贴上述规范，保证画板里所见即所得。