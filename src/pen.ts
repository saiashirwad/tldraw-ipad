import { atom, DrawShapeUtil, type Editor } from 'tldraw'

function savedWidth(): number | null {
  const value = Number(localStorage.getItem('canvas-pen-width'))
  return Number.isFinite(value) && value >= .1 && value <= 2 ? value : null
}

export const penWidth = atom<number | null>('pen width', savedWidth())

export function setPenWidth(value: number | null) {
  penWidth.set(value)
  if (value === null) localStorage.removeItem('canvas-pen-width')
  else localStorage.setItem('canvas-pen-width', String(value))
}

// DrawShapeUtil adds one to its base width, then multiplies by props.scale.
// A base of one and scale of width / 2 gives genuinely sub-pixel strokes
// using the SDK's geometry, smoothing, resizing, and SVG export paths.
export const penShapeUtils = [DrawShapeUtil.configure({
  getCustomDisplayValues(_editor, shape) {
    return typeof shape.meta.penWidth === 'number' ? { strokeWidth: 1 } : {}
  },
})]

export function installPenWidth(editor: Editor) {
  return editor.sideEffects.registerBeforeCreateHandler('shape', (shape, source) => {
    const width = penWidth.get()
    if (source !== 'user' || shape.type !== 'draw' || width === null || shape.meta.penWidth !== undefined || editor.getCurrentToolId() !== 'draw') return shape
    return { ...shape, meta: { ...shape.meta, penWidth: width }, props: { ...shape.props, dash: 'solid', scale: width / 2 } }
  })
}
