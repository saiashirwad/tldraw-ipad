#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = process.argv.slice(2)
function argument(name, fallback) {
  const index = options.indexOf(name)
  if (index === -1) return fallback
  if (!options[index + 1] || options[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`)
  return options[index + 1]
}
function run(args) {
  const result = spawnSync('xcrun', args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Device credential provisioning failed')
}

let scratch
try {
  const device = argument('--device', '00008120-001C554628214032')
  const envFile = argument('--env-file', resolve(root, '.env'))
  const text = await readFile(envFile, 'utf8')
  const line = text.split(/\r?\n/).find((row) => /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=/.test(row))
  if (!line) throw new Error('The selected env file has no DEEPSEEK_API_KEY')
  let key = line.replace(/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*/, '').trim()
  if (key.startsWith('"') || key.startsWith("'")) {
    const quote = key[0]
    const closing = key.indexOf(quote, 1)
    if (closing === -1 || !/^\s*(?:#.*)?$/.test(key.slice(closing + 1))) throw new Error('Invalid quoted DEEPSEEK_API_KEY')
    key = key.slice(1, closing)
  } else key = key.replace(/\s+#.*$/, '').trim()
  if (!key || /[\r\n\0]/.test(key)) throw new Error('Invalid DEEPSEEK_API_KEY')
  scratch = await mkdtemp(join(tmpdir(), 'canvas-key-'))
  await chmod(scratch, 0o700)
  const file = join(scratch, 'deepseek-key-import.txt')
  await writeFile(file, key, { mode: 0o600 })
  run(['devicectl', 'device', 'copy', 'to', '--device', device, '--source', file,
    '--destination', 'Documents/deepseek-key-import.txt', '--domain-type', 'appDataContainer',
    '--domain-identifier', 'in.texoport.tldrawipad'])
  run(['devicectl', 'device', 'process', 'launch', '--device', device, '--terminate-existing', 'in.texoport.tldrawipad'])
  console.log('Provider key transferred for Keychain import. The key was not added to app resources.')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  if (scratch) await rm(scratch, { recursive: true, force: true })
}
