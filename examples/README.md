# Complete lifecycle example

Run it from the repository root:

```bash
npm run example
```

The example demonstrates the complete lifecycle without external services:

1. An inbound frame declaration is placed into `DeletionClaimTracker`.
2. A Yjs transaction produces its effective `deleteSet`.
3. `captureDeletionRecords()` filters and attaches the authenticated user.
4. `MemoryDeletionStore` retains records until snapshot creation.
5. `attributeDeletions()` maps clock ranges to current tombstone positions.

In a Hocuspocus server, wire the same calls as follows:

```ts
beforeHandleMessage({ connection, update }) {
  tracker.record(connection, decodeSyncUpdateDeleteSet(update))
}

afterTransaction({ transaction, documentName }) {
  const claimed = tracker.consume(transaction.origin as object)
  // captureDeletionRecords({ beforeState, deleteSet: transaction.deleteSet }, claimed, username)
  // await store.append(documentName, records)
}

// When creating a snapshot:
const records = await store.claim(documentName)
const deletions = attributeDeletions(doc, 'default', records)
```

`MemoryDeletionStore` is intentionally tiny and dependency-free. Replace it with a Redis-backed implementation that provides atomic append/claim/restore and a TTL in production. The attribution algorithm and record format stay unchanged.
