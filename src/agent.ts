import { Box, createShapeId, parseTldrawJsonFile, serializeTldrawJson, toRichText, type Editor, type TLShapePartial, type TLPageId, type TLStoreSnapshot } from 'tldraw'

type ShapeInput = TLShapePartial & { text?: string }
type View = { pageId: TLPageId; bounds: { x: number; y: number; w: number; h: number }; updatedAt: number }

declare global {
  interface Window {
    canvas: {
      editor: Editor
      draw(shapes: ShapeInput[]): string[]
      put(input: { src: string; name: string; x?: number; y?: number; width?: number }): Promise<string[]>
      capture(all: boolean): Promise<{ url: string; bounds: object; viewUpdatedAt: number | null }>
      backup(): Promise<string>
      prepareRestore(json: string): TLStoreSnapshot
    }
  }
}

export function installAgentBridge(editor: Editor) {
  async function currentView(): Promise<View | null> {
    const { view } = await fetch('/api/status').then((r) => r.json())
    if (!view) return null
    if (Date.now() - view.updatedAt > 15000) throw new Error('The iPad view is stale. Open the canvas, or use capture --all.')
    editor.setCurrentPage(view.pageId)
    return view
  }
  window.canvas = {
    editor,
    draw(shapes) {
      if (!Array.isArray(shapes) || !shapes.length) throw new Error('Expected a nonempty JSON array of tldraw shapes.')
      const normalized = shapes.map(({ text, ...shape }) => ({
        ...shape, id: shape.id ?? createShapeId(),
        props: { ...shape.props, ...(text === undefined ? {} : { richText: toRichText(text) }) },
      })) as TLShapePartial[]
      // Stable IDs let agents revise their own shapes while leaving the user's ink alone.
      editor.run(() => {
        for (const shape of normalized) {
          if (editor.getShape(shape.id!)) editor.updateShapes([shape])
          else editor.createShapes([shape])
        }
      })
      return normalized.map((shape) => shape.id!)
    },
    async put({ src, name, x, y, width }) {
      const view = await currentView()
      const response = await fetch(src)
      if (!response.ok) throw new Error('Could not load image')
      const blob = await response.blob()
      const asset = await editor.getAssetForExternalContent({ type: 'file', file: new File([blob], name, { type: blob.type }) })
      if (!asset || asset.type !== 'image') throw new Error('Could not decode image')
      const w = width ?? Math.min(asset.props.w, (view?.bounds.w ?? 1000) * .8)
      const h = w * asset.props.h / asset.props.w
      const id = createShapeId()
      editor.createAssets([asset])
      editor.createShapes([{ id, type: 'image', x: x ?? (view ? view.bounds.x + (view.bounds.w - w) / 2 : 0),
        y: y ?? (view ? view.bounds.y + (view.bounds.h - h) / 2 : 0), props: { assetId: asset.id, w, h } }])
      return [id]
    },
    async capture(all) {
      const view = all ? null : await currentView()
      if (!all && !view) throw new Error('Open the canvas on your iPad first, or use capture --all.')
      const ids = [...editor.getCurrentPageShapeIds()]
      const bounds = view ? new Box(view.bounds.x, view.bounds.y, view.bounds.w, view.bounds.h)
        : editor.getCurrentPageBounds() ?? new Box(0, 0, 1200, 800)
      const scale = Math.min(1, 2400 / Math.max(bounds.w, bounds.h))
      if (!ids.length) {
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(bounds.w * scale))
        canvas.height = Math.max(1, Math.round(bounds.h * scale))
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#fbfaf7'; ctx.fillRect(0, 0, canvas.width, canvas.height)
        return { url: canvas.toDataURL(), bounds, viewUpdatedAt: view?.updatedAt ?? null }
      }
      const result = await editor.toImageDataUrl(ids, { format: 'png', bounds, padding: 0, background: true, darkMode: false, pixelRatio: 1, scale })
      return { url: result.url, bounds, viewUpdatedAt: view?.updatedAt ?? null }
    },
    async backup() {
      const json = await serializeTldrawJson(editor)
      const file = JSON.parse(json)
      if (file.records.some((r: any) => r.typeName === 'asset' && r.type !== 'bookmark' && r.props.src && !r.props.src.startsWith('data:'))) {
        throw new Error('An image could not be embedded. Backup was not saved; check the server and try again.')
      }
      return json
    },
    prepareRestore(json) {
      const parsed = parseTldrawJsonFile({ json, schema: editor.store.schema })
      if (!parsed.ok) throw new Error(`Invalid tldraw file: ${parsed.error.type}`)
      if (parsed.value.allRecords().filter((r) => r.typeName === 'page').length !== 1) throw new Error('Restore expects a single-page tldraw file.')
      return parsed.value.getStoreSnapshot('document')
    },
  }
}
