/**
 * dsh-drawio build driver: tsc typecheck, tsdown bundle, and a small
 * self-check that the built artifacts line up with package.json exports.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function run(cmd) {
  console.log(`> ${cmd}`)
  execSync(cmd, { cwd: root, stdio: 'inherit' })
}

run('tsc --noEmit')
run('tsdown')

// Artifact self-check: every declared export must exist after the build.
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const expected = [
  ['./lib/index.js', pkg.exports['.'].default],
  ['./lib/client.js', pkg.exports['./client'].default],
  ['./lib/index.d.ts', pkg.exports['.'].types],
]
for (const [label, rel] of expected) {
  const abs = resolve(root, rel)
  if (!existsSync(abs)) throw new Error(`missing build artifact: ${label} (${rel})`)
  console.log(`ok ${rel}`)
}
console.log('dsh-drawio build complete')
