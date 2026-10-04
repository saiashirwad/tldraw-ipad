import type { Rect } from './ask-placement'

export async function markQuestionInCapture(capture: { url: string; bounds: Rect }, marker: Rect): Promise<string> {
  const image = new Image()
  image.src = capture.url
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not mark the question in the canvas image.')
  context.drawImage(image, 0, 0)
  const sx = canvas.width / capture.bounds.w, sy = canvas.height / capture.bounds.h
  const left = Math.max(2, (marker.x - capture.bounds.x) * sx - 8)
  const top = Math.max(2, (marker.y - capture.bounds.y) * sy - 8)
  const right = Math.min(canvas.width - 2, (marker.x + marker.w - capture.bounds.x) * sx + 8)
  const bottom = Math.min(canvas.height - 2, (marker.y + marker.h - capture.bounds.y) * sy + 8)
  context.strokeStyle = '#e00000'
  context.lineWidth = 3
  context.strokeRect(left, top, right - left, bottom - top)
  return canvas.toDataURL('image/png')
}
