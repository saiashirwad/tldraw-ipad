import { createTLStore, defaultShapeUtils, getSnapshot, loadSnapshot, type Editor, type TLAssetStore } from 'tldraw'
import { penShapeUtils } from './pen'
import { readNativeFile, writeNativeFile } from './native'

const assets: TLAssetStore = {
  upload: async (_asset, file) => ({ src: await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not store image'))
    reader.onerror = () => reject(new Error('Could not read image'))
    reader.readAsDataURL(file)
  }) }),
  resolve: (asset) => asset.props.src,
}

export async function openLocalBoard() {
  const store = createTLStore({ shapeUtils: [...defaultShapeUtils.filter((shape) => shape.type !== 'draw'), ...penShapeUtils], assets })
  const saved = await readNativeFile('board.json')
  if (saved) loadSnapshot(store, JSON.parse(saved))
  let pending: string | null = null
  let saving: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer)
    pending = JSON.stringify(getSnapshot(store))
    if (!saving) {
      saving = (async () => {
        while (pending !== null) {
          const text = pending
          pending = null
          await writeNativeFile('board.json', text)
        }
      })().finally(() => { saving = null })
    }
    return saving
  }
  const listen = (onFailure: (error: unknown) => void) => {
    const remove = store.listen(() => {
      clearTimeout(timer)
      timer = setTimeout(() => { void flush().catch(onFailure) }, 120)
    }, { scope: 'document' })
    return () => { clearTimeout(timer); remove() }
  }
  return { store, flush, listen }
}

export async function captureLocalView(editor: Editor) {
  const bounds = editor.getViewportPageBounds()
  const image = await editor.toImageDataUrl([...editor.getCurrentPageShapeIds()], {
    format: 'png', bounds, padding: 0, background: true, darkMode: false, pixelRatio: 1,
    scale: Math.min(1, 2400 / Math.max(bounds.w, bounds.h)),
  })
  return { url: image.url, bounds, viewUpdatedAt: Date.now() }
}
