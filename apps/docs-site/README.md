# `@lumen/docs-site`

The Lumen documentation site, built with [VitePress 1.6](https://vitepress.dev/).

## Layout

- `.vitepress/config.mts` — VitePress configuration. `srcDir` points at the
  repo-root `docs/` directory so the markdown source remains a single
  source of truth; the developer does not have to keep two copies in sync.
- `../../docs/` — the markdown source. Same files you would read on
  GitHub.
- `../../docs-dist/` (gitignored) — the built static site.

## Scripts

```sh
# Local dev server with hot reload.
pnpm --filter @lumen/docs-site dev

# Production build to docs-dist/.
pnpm --filter @lumen/docs-site build

# Preview the built site locally.
pnpm --filter @lumen/docs-site preview
```

## Adding a new page

1. Drop a `*.md` file in `../../docs/`.
2. Add a nav / sidebar entry in `.vitepress/config.mts`.
3. The dev server hot-reloads; the next `pnpm build` picks it up.

## Why VitePress

- Static-output: deploys as plain HTML to any static host.
- Markdown-native: the same source files work as GitHub-rendered READMEs.
- First-class TypeScript config: no separate `config.js` plus
  `config.d.ts` boilerplate.
- Search index generated at build time: no backend required.
