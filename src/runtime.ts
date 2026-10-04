export type ClientIdentity = {
  instanceId: string
  buildId: string
  loadId: string
  sessionId: string | null
  synced: boolean
  shapeIds: string[]
  penUp: number
}

export function parseClientIdentity(value: unknown): ClientIdentity | null {
  if (!value || typeof value !== 'object') return null
  if (!('instanceId' in value) || typeof value.instanceId !== 'string' || value.instanceId.length > 100 ||
      !('buildId' in value) || typeof value.buildId !== 'string' || value.buildId.length > 100 ||
      !('loadId' in value) || typeof value.loadId !== 'string' || value.loadId.length > 100 ||
      !('sessionId' in value) || (value.sessionId !== null && (typeof value.sessionId !== 'string' || value.sessionId.length > 100)) ||
      !('synced' in value) || typeof value.synced !== 'boolean' ||
      !('penUp' in value) || typeof value.penUp !== 'number' || !Number.isSafeInteger(value.penUp) || value.penUp < 0 ||
      !('shapeIds' in value) || !Array.isArray(value.shapeIds) || value.shapeIds.length > 256 ||
      !value.shapeIds.every((id) => typeof id === 'string' && id.startsWith('shape:') && id.length < 200)) return null
  return { instanceId: value.instanceId, buildId: value.buildId, loadId: value.loadId, sessionId: value.sessionId,
    synced: value.synced, shapeIds: value.shapeIds, penUp: value.penUp }
}
