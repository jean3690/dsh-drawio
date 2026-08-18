/**
 * Build faces for dsh-drawio. The node half (src/index.ts + the hand-written
 * Typert host manifest src/typert.host.ts) is the host Loader entry; the
 * browser half (src/client/index.ts) is the client bundle the client-modules
 * node half serves under /plugins/dsh-drawio/client.js.
 *
 * The browser half follows the shell's client-bundle handshake exactly (the
 * official `packages/client/tsdown.client.ts` preset): a CJS bundle wrapped
 * in `window.__ModuleLoader__.load({ id, factory })`, platform modules left
 * external, every other dependency inlined, and CSS Modules compiled by
 * lightningcss inside the bundle (importing `x.module.css` yields the hashed
 * class map; the css text auto-injects a `<style data-plugin>` tag at factory
 * execution).
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Plugin id: the cordis.yml bare row name, the graph row id, and the stamped bundle id must all match. */
const PLUGIN_ID = 'dsh-drawio'

/**
 * Module specifiers the shell shares into the frozen browser module table
 * (packages/client/web/src/platform.ts) plus the runtime store exemption
 * (`@deepseek-ai/dsh-client-runtime/client`). Any value import outside this
 * list must be inlined.
 */
const PLATFORM_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css). The suffix matters: tsdown's guard matches ids
 * ending in `.css`, so the virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

export default defineConfig([
  {
    name: PLUGIN_ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2023',
    dts: true,
    clean: true,
    // ESM output under a "type": "module" package must land on .js, not .mjs.
    fixedExtension: false,
    deps: {
      // Bundle zod only (the sole non-peer dependency besides the native
      // rasterizer, which cannot be bundled): keeps the host half
      // self-contained. @resvg/resvg-js stays a regular dependency installed
      // into the profile (native prebuilds are not bundleable).
      onlyBundle: ['zod'],
      alwaysBundle: ['zod'],
      neverBundle: [/^node:/, '@resvg/resvg-js'],
    },
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      // Platform modules stay external (the factory's `require` answers them
      // from the shell's frozen module table); every other import is inlined
      // (zod, the CSS Modules shims, the shared translator).
      onlyBundle: false,
      alwaysBundle: (id: string) => (PLATFORM_EXTERNALS.includes(id) ? undefined : true),
      neverBundle: [...PLATFORM_EXTERNALS],
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        // The virtual id otherwise hides the physical stylesheet from Rolldown's watch graph.
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
        // One <style data-plugin> per module file; idempotent under re-evaluation.
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(`${PLUGIN_ID}/${basename(fileId)}`)};`,
          'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
          '  const tag = document.createElement(\'style\');',
          `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
