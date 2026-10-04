import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { useSync } from '@tldraw/sync'
import { atom, createUserId, UserRecordType, DefaultStylePanel, StylePanelSection, StylePanelColorPicker, StylePanelOpacityPicker, Tldraw, useEditor, useValue, type Editor, type TLAssetStore } from 'tldraw'
import { installAgentBridge } from './agent'
import { AskControl } from './ask'
import { installPenWidth, penShapeUtils, penWidth, setPenWidth } from './pen'
import { installFingerPan } from './navigation'
import 'tldraw/tldraw.css'
import './style.css'

const agent = new URLSearchParams(location.search).has('agent')
const ipad = new URLSearchParams(location.search).has('ipad')
const agentUsers = { currentUser: atom('agent', UserRecordType.create({ id: createUserId('agent'), name: 'Agent', color: '#777777' })) }
const assets: TLAssetStore = {
  async upload(_asset, file) {
    const response = await fetch('/api/assets', { method: 'POST', headers: { 'Content-Type': file.type }, body: file })
    if (!response.ok) throw new Error((await response.json()).error)
    return response.json()
  },
  resolve: (asset) => asset.props.src ? new URL(asset.props.src, location.origin).href : null,
}

function App() {
  const store = useSync({ uri: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/sync`, assets,
    users: agent ? agentUsers : undefined, getUserPresence: agent ? () => null : undefined,
    onCustomMessageReceived: (message) => {
      if (message.type === 'board-replaced') window.canvas?.editor.clearHistory()
    } })
  return <Tldraw store={store} shapeUtils={penShapeUtils} hideUi onMount={mount} licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}>
    {!agent && <Controls />}
  </Tldraw>
}

function mount(editor: Editor) {
  editor.user.updateUserPreferences({ colorScheme: 'light' })
  editor.setCurrentTool('draw')
  // The SDK handles pressure, palm rejection, and pinch navigation.
  const touchDevice = navigator.maxTouchPoints > 0
  editor.updateInstanceState({ isPenMode: touchDevice, isToolLocked: true })
  const saved = !agent && localStorage.getItem('canvas-view')
  if (saved) {
    try { editor.setCamera(JSON.parse(saved)) } catch { /* Use the SDK's default camera. */ }
  }
  installAgentBridge(editor)
  if (agent) return
  const removePenWidth = installPenWidth(editor)
  const removeFingerPan = touchDevice ? installFingerPan(editor) : () => {}
  const publishView = () => {
    if (document.visibilityState !== 'visible') return
    localStorage.setItem('canvas-view', JSON.stringify(editor.getCamera()))
    void fetch('/api/view', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId: editor.getCurrentPageId(), bounds: editor.getViewportPageBounds(), source: ipad ? 'ipad' : 'browser' }),
    }).catch(() => {})
  }
  publishView()
  const timer = setInterval(publishView, 500)
  return () => { clearInterval(timer); removePenWidth(); removeFingerPan() }
}

function Controls() {
  const editor = useEditor()
  const [open, setOpen] = useState(false)
  const tool = useValue('tool', () => editor.getCurrentToolId(), [editor])
  const width = useValue('pen width', () => penWidth.get(), [])
  const canUndo = useValue('undo', () => editor.getCanUndo(), [editor])
  const canRedo = useValue('redo', () => editor.getCanRedo(), [editor])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as Element).closest('.tools')) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])
  return <>
    <div className="history controls">
      <button aria-label="Undo" disabled={!canUndo} onClick={() => editor.undo()}>↶</button>
      <button aria-label="Redo" disabled={!canRedo} onClick={() => editor.redo()}>↷</button>
    </div>
    <div className="tools">
      {open && <div className="palette controls">
        <div className="tool-row">
          {['draw', 'eraser', 'select'].map((id) => <button key={id} className={tool === id ? 'active' : ''}
            aria-label={id === 'draw' ? 'Pen' : id === 'eraser' ? 'Eraser' : 'Select'}
            onClick={() => editor.setCurrentTool(id)}>{id === 'draw' ? 'Pen' : id === 'eraser' ? 'Erase' : 'Select'}</button>)}
        </div>
        {tool === 'draw' && <div className="pen-width">
          <div className="tool-row">
            {[{ label: 'Standard', value: null }, { label: 'Fine', value: .5 }, { label: 'Hairline', value: .2 }].map(({ label, value }) =>
              <button key={label} aria-pressed={width === value} className={width === value ? 'active' : ''} onClick={() => setPenWidth(value)}>{label}</button>)}
          </div>
          {width !== null && <label className="width-slider">Pen width <output>{width.toFixed(1)}</output>
            <input aria-label="Pen width" type="range" min="0.1" max="2" step="0.1" value={width} onChange={(event) => setPenWidth(Number(event.target.value))} />
          </label>}
        </div>}
        {tool === 'draw' && width !== null ? <DefaultStylePanel>
          <StylePanelSection><StylePanelColorPicker /><StylePanelOpacityPicker /></StylePanelSection>
        </DefaultStylePanel> : <DefaultStylePanel />}
      </div>}
      <AskControl />
      <button className="toggle controls" aria-label="Drawing tools" aria-expanded={open} onClick={() => setOpen(!open)}>✎</button>
    </div>
  </>
}

createRoot(document.getElementById('root')!).render(<App />)
