import { FileError, type FileSystem, type Result } from '@earendil-works/pi-durable/env'

type NativeRequest = { op: string; path?: string; text?: string; size?: number; to?: string; id?: string; url?: string; body?: string; headers?: Record<string, string> }
declare global {
  interface Window { webkit?: { messageHandlers?: { canvasNative?: { postMessage(request: NativeRequest): Promise<unknown> } } } }
}

export function randomId() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('') }

export const standalone = !!window.webkit?.messageHandlers?.canvasNative
export async function native(request: NativeRequest): Promise<unknown> {
  const bridge = window.webkit?.messageHandlers?.canvasNative
  if (!bridge) throw new Error('The local canvas requires the Canvas iPad app.')
  return bridge.postMessage(request)
}
export async function readNativeFile(path: string): Promise<string | null> {
  const value = await native({ op: 'file.read', path })
  if (value === null || typeof value === 'string') return value
  throw new Error('Invalid native file response')
}
export async function writeNativeFile(path: string, text: string) { await native({ op: 'file.write', path, text }) }

function pathName(path: string) {
  if (path.startsWith('/') || path.split('/').some((part) => part === '..') || !/^[a-zA-Z0-9_./-]+$/.test(path)) throw new FileError('invalid', 'Invalid private file path', path)
  return path.split('/').filter((part) => part && part !== '.').join('/')
}
async function result<T>(action: () => Promise<T>): Promise<Result<T, FileError>> {
  try { return { ok: true, value: await action() } }
  catch (error) { return { ok: false, error: error instanceof FileError ? error : new FileError('unknown', error instanceof Error ? error.message : 'Native storage failed') } }
}
const unsupported = async (): Promise<Result<never, FileError>> => ({ ok: false, error: new FileError('not_supported', 'Unused filesystem operation') })
const decode = new TextDecoder('utf-8', { fatal: true })

export const nativeFileSystem: FileSystem = {
  id: 'canvas-native', cwd: '.',
  absolutePath: (path) => result(async () => pathName(path)),
  joinPath: (parts) => result(async () => pathName(parts.join('/'))),
  canonicalPath: (path) => result(async () => pathName(path)),
  readTextFile: (path) => result(async () => {
    const text = await readNativeFile(pathName(path))
    if (text === null) throw new FileError('not_found', 'File does not exist', path)
    return text
  }),
  readBinaryFile: (path) => result(async () => {
    const data = await native({ op: 'file.readBytes', path: pathName(path) })
    if (data === null) throw new FileError('not_found', 'File does not exist', path)
    if (typeof data !== 'string') throw new Error('Invalid native byte response')
    return Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
  }),
  writeFile: (path, content) => result(async () => { await writeNativeFile(pathName(path), typeof content === 'string' ? content : decode.decode(content)) }),
  appendFile: (path, content) => result(async () => { await native({ op: 'file.append', path: pathName(path), text: typeof content === 'string' ? content : decode.decode(content) }) }),
  truncateFile: (path, size) => result(async () => { await native({ op: 'file.truncate', path: pathName(path), size }) }),
  flushFile: (path) => result(async () => { await native({ op: 'file.flush', path: pathName(path) }) }),
  renameFile: (path, to) => result(async () => { await native({ op: 'file.rename', path: pathName(path), to: pathName(to) }) }),
  createDir: (path) => result(async () => { await native({ op: 'file.mkdir', path: pathName(path) }) }),
  remove: (path) => result(async () => { await native({ op: 'file.remove', path: pathName(path) }) }),
  exists: (path) => result(async () => await readNativeFile(pathName(path)) !== null),
  listDir: (path) => result(async () => {
    const names = await native({ op: 'file.list', path: pathName(path) })
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) throw new Error('Invalid directory response')
    return names.map((name: string) => ({ name, path: pathName(`${path}/${name}`), kind: 'file' as const, size: 0, mtimeMs: 0 }))
  }),
  openTextLineReader: unsupported, readTextLines: unsupported, fileInfo: unsupported, createTempDir: unsupported, createTempFile: unsupported,
  cleanup: async () => {},
}

export const nativeFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  if (request.url !== 'https://api.deepseek.com/chat/completions' || request.method !== 'POST') throw new Error('Unsupported provider request')
  const id = randomId()
  const abort = () => { void native({ op: 'provider.cancel', id }).catch(() => {}) }
  request.signal.addEventListener('abort', abort, { once: true })
  try {
    if (request.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    const value = await native({ op: 'provider.fetch', id, url: request.url, body: await request.text(), headers: { 'Content-Type': 'application/json' } })
    if (request.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    if (!value || typeof value !== 'object' || !('status' in value) || typeof value.status !== 'number' || !('body' in value) || typeof value.body !== 'string') throw new Error('Invalid provider response')
    return new Response(value.body, { status: value.status, headers: { 'Content-Type': 'text/event-stream' } })
  } finally { request.signal.removeEventListener('abort', abort) }
}
