import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function sourceBuildId(root: string): string {
  const hash = createHash('sha256')
  const visit = (path: string) => {
    for (const item of readdirSync(resolve(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${path}/${item.name}`
      if (item.isDirectory()) visit(name)
      else { hash.update(name); hash.update(readFileSync(resolve(root, name))) }
    }
  }
  visit('src')
  for (const name of ['index.html', 'server.ts', 'pi.ts', 'pnpm-lock.yaml', 'package.json', 'tsconfig.json', 'vite.config.ts', 'build-id.ts']) {
    hash.update(name); hash.update(readFileSync(resolve(root, name)))
  }
  return hash.digest('hex').slice(0, 20)
}
