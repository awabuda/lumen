# @lumen/config

Layered configuration for Lumen. Merges sources in a fixed precedence
order and validates the result against a Zod schema.

## Precedence (highest wins)

1. CLI flags
2. Environment variables
3. Project config file (`./.lumen/config.yaml`)
4. User config file (`~/.lumen/config.yaml`)
5. Built-in defaults

## Quick start

```ts
import { loadConfig, defineConfig } from '@lumen/config'

const config = loadConfig({
  defaults: defineConfig({
    defaultModel: 'gpt-4o-mini',
    models: { openai: { baseUrl: 'https://api.openai.com/v1' } },
  }),
})
```

## Profiles + hot reload

```ts
import { loadConfigWithProfile, watchConfig } from '@lumen/config'

const config = await loadConfigWithProfile({ profile: 'work' })

const watcher = watchConfig({
  onChange: (event) => console.log('config changed:', event),
})
```

Downstream packages import `LumenConfig` and helper accessors; they
should never read `process.env` directly.

## License

MIT
