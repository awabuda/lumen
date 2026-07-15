import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'

// VitePress lives at apps/docs-site/.vitepress/, but the
// canonical markdown source is at the repo-root docs/
// directory. We point srcDir / outDir at absolute paths so
// the site is built and served against the same content
// tree that the developer uses for README-style reading.
//
// Path math: this file is apps/docs-site/.vitepress/config.mts,
// so three `../`s are required to escape back to the
// monorepo root. One level of `../` is wrong -- it lands
// at apps/docs/. Two levels lands at apps/. Three lands at
// the lumen repo root, which is where docs/ and the
// build output (docs-dist/) live.
const repoRootDocs = fileURLToPath(new URL('../../../docs', import.meta.url))
const repoRootDist = fileURLToPath(new URL('../../../docs-dist', import.meta.url))
// Vite's resolver starts from srcDir (lumen/docs/) and walks
// up looking for node_modules. It does not look at the
// workspace package's own node_modules. We install vue
// inside apps/docs-site/node_modules (see package.json) but
// alias `vue` to the absolute path so vite's resolver
// finds it without us having to enable shamefully-hoist
// at the monorepo level (which would weaken isolation for
// every other package).
const docsSiteVueDir = fileURLToPath(new URL('../node_modules/vue', import.meta.url))

export default defineConfig({
  // Markdown source.
  srcDir: repoRootDocs,
  // Built static site output. Lives outside the monorepo
  // workspaces (and outside the apps/docs-site/ package)
  // so turbo / biome / typecheck never mistake it for
  // source. .gitignore at the repo root excludes it.
  outDir: repoRootDist,
  // VitePress emits a 404.html by default; the lumen repo
  // does not host a 404 page in its docs, so disable it
  // to keep the build output minimal.
  ignoreDeadLinks: true,
  // Title shown in the browser tab + the search index.
  // Sub-titles are configured per-page in frontmatter.
  title: 'Lumen',
  description:
    'Lumen — a TypeScript-native agent runtime. Build autonomous agents against OpenAI, Anthropic, Mistral, Ollama, and llama.cpp.',
  // Avoid the default trailing slash so /architecture and
  // /architecture/ are the same URL — matches GitHub
  // Pages' default behaviour and avoids the "two URLs,
  // same content" SEO footgun.
  cleanUrls: true,
  lastUpdated: true,
  vite: {
    // Vite's resolver starts from srcDir (the docs/
    // directory) and walks up looking for node_modules.
    // It does not look at apps/docs-site/node_modules,
    // so the `vue` package installed alongside vitepress
    // is invisible to it. Aliasing to an absolute path
    // keeps the resolver happy without us having to
    // change workspace-level hoisting settings.
    resolve: {
      alias: {
        vue: docsSiteVueDir,
      },
    },
  },
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'Developer', link: '/developer' },
      { text: 'Security', link: '/security' },
      { text: 'L1 Audit', link: '/l1-audit' },
      { text: 'P19 Design', link: '/p19-design' },
      { text: 'P22 Design', link: '/p22-design' },
      { text: 'P22.5 Design', link: '/p22-5-design' },
      { text: 'P22.6 Design', link: '/p22-6-design' },
    ],
    sidebar: [
      {
        text: 'Overview',
        items: [{ text: 'Home', link: '/' }],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'Security', link: '/security' },
          { text: 'Pitfalls', link: '/pitfalls' },
        ],
      },
      {
        text: 'Contributing',
        items: [
          { text: 'Developer guide', link: '/developer' },
          { text: 'L1 audit checklist', link: '/l1-audit' },
        ],
      },
      {
        text: 'Roadmap',
        items: [
          { text: 'P19+ design', link: '/p19-design' },
          { text: 'P22 design', link: '/p22-design' },
          { text: 'P22.5 design', link: '/p22-5-design' },
          { text: 'P22.6 design', link: '/p22-6-design' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/lumen/lumen' }],
    footer: {
      message: 'Released under the MIT License.',
      copyright: `Copyright © ${new Date().getFullYear()} Lumen contributors.`,
    },
  },
})
