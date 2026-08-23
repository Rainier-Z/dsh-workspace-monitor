import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

assert.equal(manifest.name, 'dsh-monitor')
assert.equal(manifest.type, 'module')
assert.equal(manifest.main, 'index.js')
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
assert.ok(manifest.files.includes('cordis.patch.yml'))
assert.match(patch, /name: dsh-monitor/)
assert.match(patch, /intervalMs: 60000/)

console.log('DSH bundle manifest validation passed')
