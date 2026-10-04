import { cpSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vite'
import { sourceBuildId } from './build-id'

export default defineConfig(() => {
  const buildId = sourceBuildId(import.meta.dirname)
  const environment = process.env.NODE_ENV === 'development' ? 'development' : 'production'
  return {
    base: './',
    define: { __CANVAS_BUILD_ID__: JSON.stringify(buildId) },
    plugins: [{ name: 'canvas-local-assets', writeBundle(options) {
      const assetRoot = dirname(createRequire(import.meta.url).resolve('@tldraw/assets/selfHosted'))
      const target = resolve(options.dir ?? 'dist', 'tldraw-assets')
      mkdirSync(target, { recursive: true })
      for (const folder of ['fonts', 'icons', 'embed-icons', 'translations']) cpSync(resolve(assetRoot, folder), resolve(target, folder), { recursive: true })
    } }, { name: 'canvas-build-id', generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ buildId, environment }) })
    } }],
  }
})
