import * as esbuild from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const result = await esbuild.build({
  entryPoints: [join(root, 'src/app.ts')],
  bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022', minify: true,
})
const js = result.outputFiles[0].text
const html = readFileSync(join(root, 'index.html'), 'utf8')
const out = html.replace('<!-- APP_BUNDLE -->', () => `<script>${js}</script>`)
mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist/verifier.html'), out)
console.log(`wrote dist/verifier.html (${out.length} bytes)`)
