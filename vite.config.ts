import { defineConfig } from 'vite'
import { sourceBuildId } from './build-id'

export default defineConfig(() => {
  const buildId = sourceBuildId(import.meta.dirname)
  return {
    define: { __CANVAS_BUILD_ID__: JSON.stringify(buildId) },
    plugins: [{ name: 'canvas-build-id', generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ buildId }) })
    } }],
  }
})
