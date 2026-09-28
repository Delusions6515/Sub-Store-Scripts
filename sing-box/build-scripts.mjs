// Build the shared Sub-Store file for a Release. Output stays out of git.
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const result = await build({
  stdin: {
    contents: 'import * as library from "comment-json"; export { library }',
    resolveDir: join(root, '..'),
    sourcefile: 'comment-json-entry.js',
  },
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  write: false,
})
const output = join(root, '..', 'dist')
mkdirSync(output, { recursive: true })
writeFileSync(join(output, 'comment-json.bundle.mjs'), result.outputFiles[0].text)
const licenses = [
  ['comment-json', 'LICENSE'],
  ['array-timsort', 'LICENSE'],
  ['esprima', 'LICENSE.BSD'],
].map(([name, file]) =>
  `${name}\n${readFileSync(join(root, '..', 'node_modules', name, file), 'utf8')}`,
)
writeFileSync(join(output, 'THIRD_PARTY_LICENSES.txt'), licenses.join('\n\n---\n\n'))
