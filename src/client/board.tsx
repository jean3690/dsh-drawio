/**
 * The 画板 view: workspace diagram file list + XML editor + live SVG preview
 * (the shared zero-dependency translator runs right in the browser), with
 * save-to-workspace, PNG export and SVG copy.
 *
 * @module dsh-drawio/client/board
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { DrawioRemote } from './api.ts'
import type { ListEntry } from '../protocol.ts'
import { diagramToSvg, parseDiagrams } from '../translate.ts'
import { t } from './i18n.ts'
import { drainOpenPaths, subscribeOpenPath } from './open-queue.ts'
import styles from './board.module.css'

/** Session store shape the board reads the workspace root from. */
export interface SessionListStore {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => { current?: string; byId: Record<string, { cwd?: string }> }
}

const ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v13H4z"/><path d="M4 9h16"/><circle cx="7.5" cy="12.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12.5" r="1.2" fill="currentColor" stroke="none"/><path d="M9 17l3-3 2 2 2-3"/></svg>`

export { ICON_SVG }

type SaveState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; message: string } | { kind: 'err'; message: string }

export function BoardView({
  makeApi,
  sessions,
  fontFamily,
}: {
  /** Binds one workspace root to a fresh API client (rebuilt on session switch). */
  makeApi: (root: string) => DrawioRemote
  sessions: SessionListStore
  fontFamily: string
}): JSX.Element {
  const root = useSyncExternalStoreSafe(sessions)
  const api = useMemo(() => (root === '' ? null : makeApi(root)), [root, makeApi])
  const [entries, setEntries] = useState<ListEntry[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [xml, setXml] = useState('')
  const [draftName, setDraftName] = useState('')
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  const [renderResult, setRenderResult] = useState<{ svg: string; vertices: number; edges: number } | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [renderPending, setRenderPending] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // ---- zoom: fit-to-pane by default; an explicit zoom level once the user
  // zooms (toolbar buttons or ctrl/cmd + wheel, anchored at the cursor) -------
  const [zoom, setZoom] = useState(1)
  const [zoomFit, setZoomFit] = useState(true)
  const [paneSize, setPaneSize] = useState({ w: 0, h: 0 })

  // Natural diagram size from the rendered svg's viewBox.
  const naturalSize = useMemo(() => {
    if (renderResult === null) return null
    const match = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(renderResult.svg)
    return match === null ? null : { w: Number(match[3]), h: Number(match[4]) }
  }, [renderResult])

  // The scale that makes the diagram fit the pane (preserveAspectRatio meet).
  const fitScale = useMemo(() => {
    if (naturalSize === null || paneSize.w <= 0 || paneSize.h <= 0) return null
    return Math.min(paneSize.w / naturalSize.w, paneSize.h / naturalSize.h)
  }, [naturalSize, paneSize])

  const clampZoom = (value: number): number => Math.min(8, Math.max(0.2, value))

  const zoomBy = useCallback((factor: number): void => {
    if (fitScale === null) return
    setZoom(clampZoom((zoomFit ? fitScale : zoom) * factor))
    setZoomFit(false)
  }, [fitScale, zoomFit, zoom])

  const zoomReset = useCallback((): void => setZoomFit(true), [])

  // Wheel zoom: ctrl/cmd + wheel zooms around the cursor. Attached as a
  // NATIVE listener (passive:false) — the app shell's React delegation does
  // not reliably dispatch synthetic onWheel onto the preview subtree.
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      if (fitScale === null) return
      const oldScale = zoomFit ? fitScale : zoom
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
      const next = clampZoom(oldScale * factor)
      // Anchor the point under the cursor: compute the content-space position
      // before the scale change, then restore it once the new size is laid out.
      const rect = el.getBoundingClientRect()
      const px = event.clientX - rect.left + el.scrollLeft
      const py = event.clientY - rect.top + el.scrollTop
      const ratio = next / oldScale
      setZoom(next)
      setZoomFit(false)
      requestAnimationFrame(() => {
        el.scrollLeft = px * ratio - (event.clientX - rect.left)
        el.scrollTop = py * ratio - (event.clientY - rect.top)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [fitScale, zoomFit, zoom, renderResult])

  const zoomLabel = naturalSize !== null && fitScale !== null
    ? `${Math.round((zoomFit ? fitScale : zoom) * 100)}%`
    : '—'

  // ---- view modes: SVG-first; XML source and the file list are hidden
  // behind toggles so the diagram gets the whole column by default -----------
  const [showSource, setShowSource] = useState(false)
  const [showFiles, setShowFiles] = useState(false)

  // ---- live follow: the board tracks the file the agent is editing ----------
  const [followEnabled, setFollowEnabled] = useState(true)
  const [userEditing, setUserEditing] = useState(false)
  const [fileMtime, setFileMtime] = useState<number | null>(null)
  const userEditingRef = useRef(false)
  userEditingRef.current = userEditing
  const followRef = useRef(true)
  followRef.current = followEnabled

  // ---- file list ---------------------------------------------------------
  const refresh = useCallback(async (): Promise<void> => {
    if (root === '' || api === null) {
      setEntries(null)
      return
    }
    setListError(null)
    setEntries(null)
    try {
      const result = await api.list({ root })
      setEntries(result.entries)
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error))
      setEntries([])
    }
  }, [root, api])

  useEffect(() => {
    if (showFiles) void refresh()
  }, [refresh, showFiles])

  // ---- open one file -------------------------------------------------------
  const openFile = useCallback(async (path: string): Promise<void> => {
    if (root === '' || api === null) return
    try {
      const result = await api.read({ root, path })
      setSelected(path)
      setDraftName(path.split('/').pop() ?? path)
      setXml(result.content)
      setFileMtime(result.mtime)
      setSaveState({ kind: 'idle' })
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : String(error))
    }
  }, [root, api])

  // ---- live render (debounced) ----------------------------------------------
  useEffect(() => {
    if (xml.trim() === '') {
      setRenderResult(null)
      setRenderError(null)
      return
    }
    setRenderPending(true)
    const timer = setTimeout(() => {
      try {
        const diagrams = parseDiagrams(xml)
        const diagram = diagrams[0]!
        let vertices = 0
        let edges = 0
        const walk = (cells: typeof diagram.cells): void => {
          for (const cell of cells) {
            if (cell.edge) edges += 1
            else if (cell.vertex) vertices += 1
            walk(cell.children as typeof diagram.cells)
          }
        }
        walk(diagram.cells)
        const svg = diagramToSvg(diagram, { fontFamily })
        setRenderResult({ svg, vertices, edges })
        setRenderError(null)
      } catch (error) {
        setRenderResult(null)
        setRenderError(error instanceof Error ? error.message : String(error))
      } finally {
        setRenderPending(false)
      }
    }, 350)
    return () => {
      clearTimeout(timer)
      setRenderPending(false)
    }
  }, [xml, fontFamily])

  // ---- save -----------------------------------------------------------------
  const saveFile = useCallback(async (): Promise<void> => {
    if (root === '' || api === null || xml.trim() === '') return
    const name = draftName.trim() === '' ? 'diagram.drawio' : draftName.trim()
    const target = name.endsWith('.drawio') || name.endsWith('.xml') || name.endsWith('.svg') ? name : `${name}.drawio`
    const dir = selected === null ? '' : selected.split('/').slice(0, -1).join('/')
    const path = dir === '' ? target : `${dir}/${target}`
    setSaveState({ kind: 'busy' })
    try {
      const result = await api.save({ root, path, content: xml })
      setSelected(result.path)
      setSaveState({ kind: 'ok', message: `${t('save.ok')}: ${result.path}` })
      void refresh()
    } catch (error) {
      setSaveState({ kind: 'err', message: error instanceof Error ? error.message : String(error) })
    }
  }, [root, api, xml, draftName, selected, refresh])

  // ---- export PNG -------------------------------------------------------------
  const exportPng = useCallback(async (): Promise<void> => {
    if (renderResult === null) return
    try {
      const blob = new Blob([renderResult.svg], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const image = new Image()
      await new Promise<void>((resolveImage, reject) => {
        image.onload = () => resolveImage()
        image.onerror = () => reject(new Error('SVG decode failed'))
        image.src = url
      })
      const canvas = document.createElement('canvas')
      const scale = 2
      canvas.width = image.naturalWidth * scale
      canvas.height = image.naturalHeight * scale
      const ctx2d = canvas.getContext('2d')
      if (ctx2d === null) throw new Error('canvas unavailable')
      ctx2d.fillStyle = '#ffffff'
      ctx2d.fillRect(0, 0, canvas.width, canvas.height)
      ctx2d.drawImage(image, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      const pngUrl = canvas.toDataURL('image/png')
      const anchor = document.createElement('a')
      anchor.href = pngUrl
      anchor.download = `${(draftName || 'diagram').replace(/\.(drawio|xml|svg)$/i, '')}.png`
      anchor.click()
      setSaveState({ kind: 'ok', message: t('export.done') })
    } catch (error) {
      setSaveState({ kind: 'err', message: `${t('export.err')}: ${error instanceof Error ? error.message : String(error)}` })
    }
  }, [renderResult, draftName])

  // ---- copy SVG -----------------------------------------------------------------
  const copySvg = useCallback(async (): Promise<void> => {
    if (renderResult === null) return
    try {
      await navigator.clipboard.writeText(renderResult.svg)
      setSaveState({ kind: 'ok', message: t('copied') })
    } catch (error) {
      setSaveState({ kind: 'err', message: error instanceof Error ? error.message : String(error) })
    }
  }, [renderResult])

  // ---- official drawio editor mode ---------------------------------------------
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorNonce, setEditorNonce] = useState(0)
  const [lastKnownMtime, setLastKnownMtime] = useState<number | null>(null)
  const editorRef = useRef<HTMLIFrameElement>(null)

  // Observe the preview pane. The board may first mount while the session
  // root is still '' (empty branch — no pane element), and the pane div is
  // replaced when the editor mode toggles, so re-attach whenever either
  // changes. The observer fires again on col open/close (display:none → 0).
  useEffect(() => {
    const el = previewRef.current
    if (el === null) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect !== undefined) setPaneSize({ w: rect.width, h: rect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [root, editorOpen])

  const buildEditorUrl = useCallback((root: string, path: string): string => {
    // Encode the raw URL exactly ONCE. The other query params are flat values;
    // putting `raw` through URLSearchParams would double-encode the % facets.
    const raw = `/dsh-drawio/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
    const params = new URLSearchParams({
      embed: '1',
      spin: '1',
      proto: 'json',
      ui: 'min',
      mod: '0',
    })
    return `/drawio/index.html?${params.toString()}&url=${encodeURIComponent(raw)}`
  }, [])

  // Open the editor for the selected file.
  const openEditor = useCallback(async (): Promise<void> => {
    if (root === '' || api === null || selected === null) return
    try {
      const info = await api.read({ root, path: selected })
      setLastKnownMtime(info.mtime)
      setEditorNonce((n) => n + 1)
      setEditorOpen(true)
      setSaveState({ kind: 'idle' })
    } catch (error) {
      setSaveState({ kind: 'err', message: `${t('action.editor')}: ${error instanceof Error ? error.message : String(error)}` })
    }
  }, [root, api, selected])

  // Editor -> board save bridge (drawio posts {event:'save', xml} to the opener).
  const persistFromEditor = useCallback(async (xml: string): Promise<void> => {
    if (root === '' || api === null || selected === null) return
    setSaveState({ kind: 'busy' })
    try {
      const result = await api.save({ root, path: selected, content: xml })
      setLastKnownMtime(result.mtime)
      // Sync the editor's saved content into the board state so the XML editor
      // and the SVG preview re-render immediately (not only after a reload).
      setXml(xml)
      setSaveState({ kind: 'ok', message: `${t('save.ok')}: ${result.path}` })
      void refresh()
    } catch (error) {
      setSaveState({ kind: 'err', message: error instanceof Error ? error.message : String(error) })
    }
  }, [root, api, selected, refresh])

  // Inject the diagram XML into the drawio editor. drawio does not require a
  // handshake to receive the load message, and its emit of `init` is
  // unreliable, so inject on a retry loop: every ~2s, cross-check whether the
  // canvas has rendered shapes; if not, push the XML (object + legacy string
  // forms) and keep polling until it lands or the budget runs out.
  const injectEditorXml = useCallback(async (): Promise<void> => {
    if (root === '' || api === null || selected === null || !editorOpen) return
    for (let attempt = 0; attempt < 14; attempt += 1) {
      if (!editorOpen) return
      const iframe = editorRef.current
      if (iframe === undefined || iframe === null) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        continue
      }
      // Rendered already? Stop injecting (avoids resetting user edits).
      try {
        const doc = iframe.contentDocument
        const rendered = doc !== null
          && doc.querySelectorAll('.geDiagramContainer svg path, .geDiagramContainer svg rect, .geDiagramContainer foreignObject').length > 0
        if (rendered) return
      } catch {
        // Cross-origin or not ready: keep going.
      }
      try {
        const info = await api.read({ root, path: selected })
        const target = iframe.contentWindow
        if (target !== null) {
          target.postMessage({ event: 'load', data: { xml: info.content } }, window.location.origin)
          target.postMessage(JSON.stringify({ action: 'load', xml: info.content }), window.location.origin)
        }
      } catch {
        // File unreadable: nothing to inject yet.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 2000))
    }
  }, [editorOpen, root, api, selected])

  useEffect(() => {
    if (!editorOpen) return
    // Kick off right away; init acts as a soft first trigger.
    void injectEditorXml()
    const onMessage = (event: MessageEvent): void => {
      const frame = editorRef.current?.contentWindow
      if (frame === undefined || event.source !== frame) return
      let data = event.data
      // drawio posts its embed messages as JSON strings.
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data)
        } catch {
          return
        }
      }
      if (typeof data !== 'object' || data === null) return
      const message = data as { event?: string; xml?: string }
      if (message.event === 'init') {
        void injectEditorXml()
        return
      }
      if (message.event === 'save' && typeof message.xml === 'string') {
        void persistFromEditor(message.xml)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [editorOpen, root, api, selected, persistFromEditor, injectEditorXml])

  // External change -> auto-reload the editor (the agent may have just edited
  // the file). Cheap stat poll (no content transfer); falls back to a full
  // read on hosts without the /stat route. The reload itself re-reads via
  // ?url=, so only the mtime is ever needed here. Only reload when the mtime
  // moved without this editor writing it.
  useEffect(() => {
    if (!editorOpen || root === '' || api === null || selected === null) return
    const timer = setInterval(async () => {
      const mtime = await fileMtimeOf(api, root, selected)
      if (mtime === null || mtime === lastKnownMtime) return
      const wasEditorSave = lastKnownMtime !== null && mtime > lastKnownMtime
      setLastKnownMtime(mtime)
      if (wasEditorSave) {
        setEditorNonce((n) => n + 1)
        setSaveState({ kind: 'ok', message: t('editor.externalReload') })
      }
    }, 2500)
    return () => clearInterval(timer)
  }, [editorOpen, root, api, selected, lastKnownMtime])



  const closeEditor = (): void => {
    setEditorOpen(false)
  }

  // The host broadcasts agent drawio activity through the open queue: live
  // events arrive here as they happen; the SSE replay may arrive BEFORE this
  // tree mounts and/or before a workspace root is selected, so the queue is
  // drained whenever a root becomes available (mount included).
  useEffect(() => {
    if (root === '' || api === null) return
    const openIfNew = (path: string): void => {
      setSelected((prev) => {
        if (prev !== path) void openFile(path)
        return prev
      })
    }
    const unsubscribe = subscribeOpenPath(openIfNew)
    const queued = drainOpenPaths()
    if (queued.length > 0) openIfNew(queued[queued.length - 1]!)
    return unsubscribe
  }, [root, api, openFile])

  // Live follow (preview mode): poll the file's stat every 1.5s (a tiny JSON
  // round trip, no content) and only read + re-render when the mtime moved —
  // unless the user is mid-edit (their keystrokes must not be clobbered).
  useEffect(() => {
    if (root === '' || api === null || selected === null || editorOpen) return
    let last = fileMtime
    const timer = window.setInterval(async () => {
      const mtime = await fileMtimeOf(api, root, selected)
      if (mtime === null || mtime === last) return
      last = mtime
      setFileMtime(mtime)
      if (followRef.current && !userEditingRef.current) {
        try {
          const result = await api.read({ root, path: selected })
          setXml(result.content)
          setSaveState({ kind: 'ok', message: t('follow.synced') })
        } catch {
          // file vanished between stat and read: keep the current view
        }
      }
    }, 1500)
    return () => window.clearInterval(timer)
  }, [root, api, selected, editorOpen, fileMtime])

  // File list auto-refresh: catch agent-created/deleted diagrams. Only runs
  // while the pane is visible — the list scan walks the workspace tree, so
  // hidden-pane polling would be pure waste.
  useEffect(() => {
    if (root === '' || api === null) return
    if (!showFiles) return
    void refresh()
    const timer = window.setInterval(() => {
      if (!followRef.current) return
      void api.list({ root }).then((result) => {
        setEntries((prev) => {
          if (prev === null) return prev
          const key = (list: typeof prev): string => list.map(e => `${e.path}:${e.mtime}`).join('|')
          return key(result.entries) === key(prev) ? prev : result.entries
        })
      }).catch(() => {})
    }, 5000)
    return () => window.clearInterval(timer)
  }, [root, api, showFiles, refresh])


  const newFile = (): void => {
    setSelected(null)
    setDraftName(`diagram-${Date.now().toString(36)}.drawio`)
    setXml('')
    setRenderResult(null)
    setRenderError(null)
    setSaveState({ kind: 'idle' })
  }

  if (root === '') {
    return (
      <div className={styles.board}>
        <div className={styles.empty}>{t('panel.noRoot')}</div>
      </div>
    )
  }

  return (
    <div className={styles.board} data-dsh-drawio-board>
      <div className={styles.toolbar}>
        <span className={styles.title}>{t('panel.title')}</span>
        <span className={styles.root} title={root}>{root}</span>
        <button type="button" className={styles.btn} onClick={() => void refresh()}>{t('files.refresh')}</button>
        <button type="button" className={styles.btn} onClick={newFile}>{t('editor.newFile')}</button>
        <button
          type="button"
          className={showFiles ? styles.btnActive : styles.btn}
          title={t('files.tip')}
          onClick={() => setShowFiles((v) => !v)}
        >
          {t('files.toggle')}
        </button>
        <span className={styles.spacer} />
        <input
          className={styles.nameInput}
          value={draftName}
          placeholder={t('save.placeholder')}
          spellCheck={false}
          onChange={(event) => setDraftName(event.target.value)}
        />
        <button type="button" className={styles.btnPrimary} disabled={saveState.kind === 'busy'} onClick={() => void saveFile()}>
          {saveState.kind === 'busy' ? t('save.busy') : t('action.save')}
        </button>
        <button type="button" className={styles.btn} disabled={renderResult === null} onClick={() => void exportPng()}>{t('action.exportPng')}</button>
        <button type="button" className={styles.btn} disabled={renderResult === null} onClick={() => void copySvg()}>{t('action.copySvg')}</button>
        {!editorOpen && (
          <>
            <button type="button" className={styles.btn} disabled={renderResult === null} title={t('zoom.out')} onClick={() => zoomBy(0.8)}>−</button>
            <span className={styles.zoomLabel} title={t('zoom.tip')}>{zoomLabel}</span>
            <button type="button" className={styles.btn} disabled={renderResult === null} title={t('zoom.in')} onClick={() => zoomBy(1.25)}>+</button>
            <button
              type="button"
              className={zoomFit ? styles.btnActive : styles.btn}
              disabled={renderResult === null}
              title={t('zoom.fit')}
              onClick={zoomReset}
            >
              {t('zoom.fit')}
            </button>
          </>
        )}
        <button
          type="button"
          className={showSource ? styles.btnActive : styles.btn}
          title={t('source.tip')}
          onClick={() => setShowSource((v) => !v)}
        >
          {t('action.source')}
        </button>
        <button
          type="button"
          className={followEnabled ? styles.btnActive : styles.btn}
          title={t('follow.tip')}
          onClick={() => setFollowEnabled((v) => !v)}
        >
          {followEnabled ? t('follow.on') : t('follow.off')}
        </button>
        <button
          type="button"
          className={selected === null || root === '' ? styles.btnDisabled : editorOpen ? styles.btnActive : styles.btnPrimary}
          disabled={selected === null || root === ''}
          onClick={() => {
            if (editorOpen) closeEditor()
            else void openEditor()
          }}
        >
          {editorOpen ? t('action.editorClose') : t('action.editor')}
        </button>
      </div>

      <div className={styles.main}>
        {showFiles && (
        <div className={styles.filePane}>
          <div className={styles.fileHeader}>{entries === null ? t('files.loading') : `${entries.length} files`}</div>
          <div className={styles.fileList}>
            {listError !== null && <div className={styles.error}>{listError}</div>}
            {entries === null && listError === null && <div className={styles.hint}>{t('files.loading')}</div>}
            {entries !== null && entries.length === 0 && listError === null && <div className={styles.hint}>{t('files.empty')}</div>}
            {entries?.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className={selected === entry.path ? `${styles.file} ${styles.fileActive}` : styles.file}
                title={`${entry.path} · ${entry.size} B`}
                onClick={() => void openFile(entry.path)}
              >
                <span className={styles.fileIcon} dangerouslySetInnerHTML={{ __html: ICON_SVG }} />
                <span className={styles.fileName}>{entry.path}</span>
              </button>
            ))}
          </div>
        </div>
        )}

        <div className={styles.editPane}>
          {editorOpen && selected !== null ? (
            <>
              <div className={styles.editorHeader}>
                <span>{selected} · {t('action.editor')}</span>
                <button type="button" className={styles.btn} onClick={() => setEditorNonce((n) => n + 1)}>{t('action.reload')}</button>
                {saveState.kind === 'ok' && <span className={styles.okInline}>{saveState.message}</span>}
                {saveState.kind === 'err' && <span className={styles.errorInline}>{saveState.message}</span>}
              </div>
              <iframe
                key={editorNonce}
                ref={editorRef}
                className={styles.editorFrame}
                src={buildEditorUrl(root, selected)}
                title="drawio editor"
              />
            </>
          ) : (
            <>
          <div className={styles.previewHeader}>
            <span>{selected ?? t('editor.newFile')}</span>
            {renderError !== null && <span className={styles.errorInline}>{t('render.err')}</span>}
            {renderResult !== null && <span className={styles.stats}>{t('preview.stats', { vertices: renderResult.vertices, edges: renderResult.edges })}</span>}
          </div>
          <div className={styles.preview} ref={previewRef}>
            {renderResult === null && renderError === null && <div className={styles.hint}>{t('preview.empty')}</div>}
            {renderError !== null && <div className={styles.error}>{renderError}</div>}
            {renderResult !== null && (
              <div className={styles.previewScroll} ref={scrollRef}>
                <div
                  className={styles.previewSvg}
                  style={naturalSize === null || zoomFit
                    ? { width: '100%', height: '100%' }
                    : { width: naturalSize.w * zoom, height: naturalSize.h * zoom }}
                  dangerouslySetInnerHTML={{ __html: renderResult.svg }}
                />
              </div>
            )}
          </div>
          {showSource && (
            <>
              <textarea
                className={styles.editor}
                value={xml}
                spellCheck={false}
                placeholder={t('editor.placeholder')}
                onFocus={() => setUserEditing(true)}
                onBlur={() => setUserEditing(false)}
                onChange={(event) => setXml(event.target.value)}
              />
              {saveState.kind === 'err' && <div className={styles.errorBar}>{saveState.message}</div>}
              {saveState.kind === 'ok' && <div className={styles.okBar}>{saveState.message}</div>}
            </>
          )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Subscribe the workspace root to the session store ('' when none). */
function useSyncExternalStoreSafe(sessions: SessionListStore): string {
  const [root, setRoot] = useState<string>(() => currentRoot(sessions))
  useEffect(() => {
    const unsubscribe = sessions.subscribe(() => {
      setRoot(currentRoot(sessions))
    })
    return unsubscribe
  }, [sessions])
  return root
}

function currentRoot(sessions: SessionListStore): string {
  try {
    const snapshot = sessions.getSnapshot()
    const id = snapshot.current
    const cwd = id === undefined ? undefined : snapshot.byId[id]?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : ''
  } catch {
    return ''
  }
}

/**
 * Current mtime of one diagram file — the cheap poll primitive. Prefers the
 * light /stat route; falls back to a full read on hosts without it (the
 * client stays compatible across host versions). Returns null when the file
 * is unreadable.
 */
async function fileMtimeOf(api: DrawioRemote, root: string, path: string): Promise<number | null> {
  try {
    return (await api.stat({ root, path })).mtime
  } catch {
    try {
      return (await api.read({ root, path })).mtime
    } catch {
      return null
    }
  }
}