# dsh-drawio

DSH（DeepSeek Harness）Web GUI 的 diagrams.net（drawio）插件：**agent 画图工具 + 侧边栏「Drawio 画板」**，工作区 `.drawio` 文件所见即所得。

```
用户/模型 → drawio XML (mxfile) → 纯 TS 翻译器 → SVG → PNG（对话内联预览 / 画板实时渲染 / 导出）
```

## 能力（AI 驱动 drawio）

### Agent 工具（默认开启，可配置关闭）

| 工具 | 作用 |
|---|---|
| `drawio_template` | 生成 4 类图的 mxfile 骨架：flowchart / architecture / network / orgchart |
| `drawio_edit` | **结构化改图**：upsert/delete/move/resize/restyle/relabel 节点与连线，改完写回 + 渲染预览。模型绝不手改 XML |
| `drawio_validate` | 解析校验工作区 `.drawio` 文件或内联 XML，报告节点/连线/结构问题 |
| `drawio_render` | 渲染为 SVG（+PNG），写入工作区，并在对话中内联 PNG 预览 |

配套 skill `skills/drawio/SKILL.md`：模型按受支持样式子集产出 XML、用 `drawio_edit` 改图，保证渲染一致。

### 画板（右侧并排栏）

- **边对话边看图**：画板是 frame grid 的最右侧隐式列（宽度可拖 300~1000px 并持久化），打开时对话自动缩窄但**始终可见**，不再占用/隐藏会话区
- 列出工作区所有 `.drawio` 文件（递归扫描，深度与条数受限）
- **官方 drawio 编辑器嵌入**：选中文件 → 「在编辑器中打开」→ 内置 diagrams.net webapp（本地 assets，离线可用）→ 拖拽节点/连线/样式，File → Save 经 postMessage 桥自动写回工作区（保存后画板 XML/预览即时同步）
- **AI 联动**：agent 用 `drawio_edit` 改文件后，已打开的编辑器自动重载刷新
- **缩放看图**：工具栏 `− % + 适应` 缩放，或 Ctrl/⌘ + 滚轮在光标处缩放（放大后可滚动平移）；文件列表默认隐藏、图占满画板，点「文件」再展开
- 备用的 XML 源码 + SVG 预览分屏编辑、导出 PNG、复制 SVG
- 支持泳道/分组/富文本标签/正交连线/虚线/箭头等常见特性

### 渲染覆盖范围（纯 TS 零依赖翻译器，宿主与浏览器共用）

- 形状：矩形、圆角、椭圆、菱形、六边形、三角、圆柱、泳道、纯文本、图片占位
- 样式：填色/描边/线宽/虚线/透明度/字号/颜色/粗斜下划线/对齐/间距/自动换行
- HTML 标签：`<b> <i> <u> <font> <span style> <br> <h1-h6>` 及实体
- 连线：显式 waypoints、`orthogonalEdgeStyle` 自动布线、`curved` 平滑、起止箭头（classic/block/open/oval/diamond）、边标签与 `exitX/exitY/entryX/entryY` 锚点
- 分组/泳道子节点坐标偏移、`dx/dy` 页偏移、压缩 mxfile（需 inflater）

## 安装

```bash
dsh plugin --profile web add link:/home/jean/program/dsh-drawio
```

重启 `dsh web` 后生效：侧边栏出现「Drawio 画板」入口，四个 `drawio_*` 工具进入模型工具集，skill 自动可加载，内置 drawio webapp 挂在 `/drawio/*`。

### AI 驱动用法

```
我要一张登录流程图
  → agent: drawio_template 骨架 → 写 docs/登录流程.drawio → drawio_render（对话内预览）
    你在画板里点开该文件「在编辑器中打开」→ 官方编辑器拖拽精修 → Save 写回
刚才那张图把「校验通过？」改成菱形，并加一条「验证码校验」分支
  → agent: read 现有 .drawio（记住 cell id）→ drawio_edit(结构化 ops) → 预览
    画板里开着的编辑器自动刷新
```

### 配置（cordis.patch.yml → `dsh plugin` 后编辑 profile 的 cordis.yml 或补丁）

```yaml
- insert:
    - id: dsh-drawio
      name: dsh-drawio
      config:
        agentTools: ['drawio_validate', 'drawio_render', 'drawio_template']  # 或 '*' / []
        pngScale: 2      # PNG 预览倍率
        fontFamily: "Helvetica, Arial, 'PingFang SC', sans-serif"
```

## 开发

```bash
npm install --cache .npm-cache   # 本机 ~/.npm 只读时用本地缓存
npm run build                    # tsc 类型检查 + tsdown 双端打包 + 产物自检
node test/smoke.mjs              # 冒烟：样例流程图 → SVG → PNG
node test/edge.mjs               # 边界：泳道/分组/富文本/压缩 mxfile
node test/edit.mjs               # drawio_edit 结构化增删改
```

`src/translate.ts` 是核心翻译器：**零依赖、无 DOM、无 Node 内置模块**，同时打进宿主（lib/index.js）与浏览器（lib/client.js）两个包。宿主用 `@resvg/resvg-js` 做 PNG 栅格化（唯一原生依赖）。`assets/drawio-webapp/` 是官方 draw.io v31.1.8 静态资源（从 GitHub release 解包，去掉 WAR 的 Java 部分）——本地上游离线可用。

`src/translate.ts` 是核心翻译器：**零依赖、无 DOM、无 Node 内置模块**，同时打进宿主（lib/index.js）与浏览器（lib/client.js）两个包。宿主用 `@resvg/resvg-js` 做 PNG 栅格化（唯一原生依赖）。

## 已知限制

- `shape=image` 与复杂表格/专用 UML 形状渲染为占位（虚线框 + 标签）
- 无显式 waypoints 的折线只做基础正交布线（直连 + 中点折），与 drawio 的完整路由算法有差异——agent 生成时按 skill 规范写 points 即可完全一致
- 画板是 DOM 级注入（会话中心栏），与 task-board / ssh / toolbox 面板互斥共存

## License

Apache-2.0
