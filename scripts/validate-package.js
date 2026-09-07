import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manifestBytes = await readFile(new URL('../package.json', import.meta.url))
assert.notEqual(
  manifestBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
  true,
  'package.json must be UTF-8 without BOM',
)
const manifest = JSON.parse(manifestBytes.toString('utf8'))
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

assert.equal(manifest.name, 'dsh-workspace-monitor')
assert.equal(manifest.type, 'module')
assert.equal(manifest.main, 'index.js')
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
for (const dependency of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-storage-domain', 'zod']) {
  assert.ok(manifest.peerDependencies?.[dependency], `${dependency} must be a peer dependency`)
}
assert.ok(manifest.files.includes('cordis.patch.yml'))
assert.match(patch, /name: dsh-workspace-monitor/)
assert.match(patch, /intervalMs: 60000/)
assert.doesNotMatch(patch, /reportUnchanged|workspace:|prompt:/)

console.log('DSH bundle manifest validation passed')
