# yjs-v13-deletion-attribution

[中文文档（README.zh-CN.md）](./README.zh-CN.md)

Attribute Yjs deletions to users even though a Yjs tombstone does not store the deleting user's identity.

## The problem

Yjs `DeleteSet` identifies deleted structs by `(clientID, clock, length)`. It does **not** identify the user who performed the delete. Once a transaction has finished, the tombstone contains no reliable author field to recover later.

This package uses a two-phase approach:

1. During the inbound update transaction, capture the ranges declared by the frame and intersect them with the transaction's effective `deleteSet`.
2. Persist those clock ranges with the authenticated user. Later, match them to tombstones in the persisted Y.Doc and emit zero-width marks in the current document coordinate space.

The intersection is important. `transaction.origin` alone is unsafe because a `SyncStep2` can carry another user's history, pending deletes can be replayed by another transaction, and a concurrent duplicate delete can become a no-op.

## API

```ts
import {
  captureDeletionRecords,
  attributeDeletions,
} from 'yjs-v13-deletion-attribution'

// In the transaction callback / afterTransaction hook:
const records = captureDeletionRecords(
  {
    beforeState,             // clientID -> next clock known before apply
    deleteSet: transaction.deleteSet,
  },
  claimedRanges,             // DeleteSet declared by this SYNC_UPDATE frame
  authenticatedUsername,
)

// Store `records` durably or in a short-lived per-document queue.
const marks = attributeDeletions(doc, 'default', records, {
  isLeaf: nodeName => nodeName === 'image',
})
// [{ at: 2, author: 'bob' }]
```

For Hocuspocus/y-protocols envelopes, `decodeSyncFrame()` extracts the `SYNC_UPDATE` DeleteSet and deliberately returns an empty claim for `SyncStep2`.

`DeletionRecord` stores Yjs clock ranges rather than ProseMirror positions. Clock IDs are stable while document positions move. `DeletionMark.at` is zero-width because deleted content is absent from the current coordinate space.

## Safety rules

- Only attribute a real `SYNC_UPDATE`; do not attribute `SyncStep2` state replay.
- Intersect frame-declared ranges with the transaction's effective DeleteSet.
- Reject ranges whose deleted structs were unknown before the transaction.
- Do not infer a deleting author from the tombstone or from the deleted item's creator.
- Treat the external records as the source of deletion authors; the Y.Doc only supplies tombstone positions.

The library includes an optional `RedisDeletionStore` that accepts an injected Redis client's `eval` method. It deliberately does not include a Hocuspocus protocol adapter or a database adapter; the host application owns frame parsing, authenticated user lookup, and snapshot persistence.

## Development

```bash
npm install
npm run check
```

The tests use real Yjs transactions and verify the clock-range intersection, unknown-struct guard, tombstone matching, and adjacent deletes by different users.
