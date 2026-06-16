# @lumen/memory

Concrete memory stores for the Lumen agent. This package re-exports
the `BaseMemoryStore` / `BaseVectorMemoryStore` contracts from
`@lumen/core` and ships two reference implementations plus a vector
retrieval layer.

## Stores

| Class | Storage | Use it for |
|---|---|---|
| `InMemoryStore` | `Map` | Tests, ephemeral agents, small sessions |
| `SqliteStore` | `better-sqlite3` + FTS5 + WAL | The default. Cross-process safe, full-text search, vector search via `sqlite-vec` or brute-force |

`SqliteStore` extends `BaseVectorMemoryStore` (P7.1), so it can be
used directly with `HybridRetriever` without any duck-typing.

## Quick start

```ts
import { SqliteStore, InMemoryStore } from '@lumen/memory'

// Default: SQLite with FTS5 + optional vector search
const store = new SqliteStore({ path: '~/.lumen/memory.db' })
await store.init()

// Tests
const ephemeral = new InMemoryStore()
await ephemeral.init()
```

## Retrievers

```ts
import { HybridRetriever, TextOnlyRetriever, SqliteStore } from '@lumen/memory'

const store = new SqliteStore({ path: '~/.lumen/memory.db' })
await store.init()

// Text + vector hybrid (requires SqliteStore extends BaseVectorMemoryStore)
const retriever = new HybridRetriever({
  store,
  embedder: myEmbedder, // any TextEmbedder
})

const hits = await retriever.retrieve({
  query: 'What did we discuss about the Phoenix project?',
  topK: 10,
  embedding: await embedder.embed('What did we discuss about the Phoenix project?'),
})
```

For stores without vector support, use `TextOnlyRetriever`.

## RAG pipeline

`BaseRagPipeline` + `RagPipeline` (P6.1) composes chunking,
embedding, vector storage, and top-K retrieval into a single
ingest/retrieve API:

```ts
import { RagPipeline } from '@lumen/memory'

const rag = new RagPipeline({
  embedder,
  store,
  chunker: (text) => chunkByParagraph(text, { maxChars: 1024 }),
})

await rag.ingest({ documentId: 'doc-1', text: '...' })
const citations = await rag.retrieve({ query: '...', topK: 5 })
```

`ingest` is idempotent — re-ingesting the same `documentId` atomically
replaces prior chunks.

## Reflection + conflict detection

- `RuleBasedReflector` / `LLMReflector` extract facts from sessions.
- `KeywordConflictDetector` / `LLMConflictDetector` flag contradictions
  across the memory store.
- `ProfileBuilder` assembles a long-term user profile from extracted
  facts.

## License

MIT
