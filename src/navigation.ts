import type { Editor } from 'tldraw'

// Pen mode leaves touch pointers out of the SDK's drawing state. Handle only
// single-finger camera motion here; the SDK still owns two-finger pinch/zoom.
export function installFingerPan(editor: Editor) {
  const container = editor.getContainer()
  const fingers = new Map<number, { x: number; y: number; startX: number; startY: number; at: number; dragged: boolean }>()
  let penDown = false
  let blocked = false
  let penLiftedAt = -Infinity
  const down = (event: PointerEvent) => {
    if ((event.target as Element).closest('.tools, .history, .tlui, .question-controls')) return
    if (event.pointerType === 'pen') {
      penDown = true
      blocked = fingers.size > 0
      return
    }
    if (event.pointerType !== 'touch') return
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, at: performance.now(), dragged: false })
    if (penDown || performance.now() - penLiftedAt < 200 || fingers.size > 1 || event.width > 45 || event.height > 45) blocked = true
    if (!blocked) editor.stopCameraAnimation()
  }
  const move = (event: PointerEvent) => {
    const previous = fingers.get(event.pointerId)
    if (!previous) return
    const dragged = previous.dragged || Math.hypot(event.clientX - previous.startX, event.clientY - previous.startY) > 6
    fingers.set(event.pointerId, { ...previous, x: event.clientX, y: event.clientY, dragged })
    if (!dragged || blocked || penDown || fingers.size !== 1 || editor.inputs.getIsPinching()) return
    const { x, y, z } = editor.getCamera()
    editor.setCamera({ x: x + (event.clientX - previous.x) / z, y: y + (event.clientY - previous.y) / z, z }, { immediate: true })
  }
  const up = (event: PointerEvent) => {
    if (event.pointerType === 'pen') {
      penDown = false
      penLiftedAt = performance.now()
    }
    const finger = fingers.get(event.pointerId)
    if (finger && event.type === 'pointerup' && !blocked && !penDown && fingers.size === 1 && !editor.inputs.getIsPinching() &&
      !finger.dragged && performance.now() - finger.at < 450 && Math.hypot(event.clientX - finger.startX, event.clientY - finger.startY) <= 6) {
      const shape = editor.getShapeAtPoint(editor.screenToPage({ x: event.clientX, y: event.clientY }), { hitInside: true })
      if (shape?.meta.agentAnswer) container.dispatchEvent(new CustomEvent('inspect-question-answer', { detail: shape.id }))
    }
    fingers.delete(event.pointerId)
    if (!fingers.size) blocked = false
  }
  container.addEventListener('pointerdown', down, true)
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', up, true)
  window.addEventListener('blur', reset)
  function reset() { fingers.clear(); penDown = false; blocked = false }
  return () => {
    container.removeEventListener('pointerdown', down, true)
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', up, true)
    window.removeEventListener('blur', reset)
  }
}
