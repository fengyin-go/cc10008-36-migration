// 把离线测试用 esbuild 打包成 Node 可执行模块，再交给 node --test。
// 测试文件可以沿用项目里的无扩展名导入与 @/ 别名，不需要额外 loader。
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '.tmp')
mkdirSync(outDir, { recursive: true })

const entries = [
  ['share-migration.test.ts', 'share-migration.test.mjs'],
  ['share-store.test.ts', 'share-store.test.mjs'],
]

let failed = false
for (const [input, output] of entries) {
  const outfile = join(outDir, output)
  await build({
    entryPoints: [join(here, input)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['node:test', 'node:assert'],
    alias: { '@': join(here, '..', 'src') },
    outfile,
    logLevel: 'warning',
  })
  const run = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' })
  if ((run.status ?? 1) !== 0) failed = true
}

process.exit(failed ? 1 : 0)
