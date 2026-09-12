import * as Y from 'yjs'
import {
  attributeDeletions,
  captureDeletionRecords,
  collectTransactionDeletions,
  DeletionClaimTracker,
  decodeSyncFrame,
  MemoryDeletionStore,
  SYNC_UPDATE,
} from '../src/index.js'

/**
 * This is the complete host-side lifecycle in a small runnable example:
 * frame declaration -> transaction capture -> store -> snapshot materialization.
 *
 * A Hocuspocus integration calls `tracker.record(connection, claimedRanges)` in
 * beforeHandleMessage and `tracker.consume(origin)` in afterTransaction. Redis
 * can replace MemoryDeletionStore without changing the capture/materialization
 * code.
 */
const documentId = 'example-document'
const store = new MemoryDeletionStore()
const tracker = new DeletionClaimTracker<object>()
const connection = {}

const seed = new Y.Doc()
const seedFragment = seed.getXmlFragment('default')
seed.transact(() => {
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.push([new Y.XmlText('hello world')])
  seedFragment.push([paragraph])
})

// The server and client start from the same state.
const serverDoc = new Y.Doc()
Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(seed))
const clientDoc = new Y.Doc()
Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(seed))
const clientFragment = clientDoc.getXmlFragment('default')

// In a real adapter this is decoded from the inbound SYNC_UPDATE frame.
let claimedRanges: ReturnType<typeof collectTransactionDeletions> = []
clientDoc.on('update', update => {
  // A production adapter wraps `update` in the sync envelope first. The small
  // helper below builds that envelope for this standalone example.
  const envelope = syncUpdateEnvelope('example-document', update)
  claimedRanges = [...(decodeSyncFrame(envelope)?.claimedDeletions ?? [])]
})

let beforeState = new Map<number, number>()
for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(serverDoc))) {
  beforeState.set(client, clock)
}

serverDoc.on('afterTransaction', transaction => {
  const claimed = tracker.consume(transaction.origin as object)
  if (claimed === null) return
  const records = captureDeletionRecords(
    {
      beforeState,
      deleteSet: transaction.deleteSet,
    },
    claimed,
    'alice'
  )
  void store.append(documentId, records)
})

clientDoc.transact(() => {
  ;(clientFragment.get(0) as Y.XmlElement).get(0).delete(6, 5)
})
// The example uses the connection as transaction origin, as Hocuspocus does.
// A real beforeHandleMessage hook performs this before applyUpdate.
tracker.record(connection, claimedRanges)
Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(serverDoc)), connection)

const records = await store.claim(documentId)
const marks = attributeDeletions(serverDoc, 'default', records)
console.log({ records, marks })
// => marks contains zero-width positions and their authenticated authors.

seed.destroy()
clientDoc.destroy()
serverDoc.destroy()

function syncUpdateEnvelope(documentName: string, update: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(documentName)
  return new Uint8Array([
    ...varUintBytes(name.length),
    ...name,
    0,
    SYNC_UPDATE,
    ...varBytes(update),
  ])
}

function varBytes(value: Uint8Array): number[] {
  return [...varUintBytes(value.length), ...value]
}

function varUintBytes(value: number): number[] {
  const bytes: number[] = []
  do {
    const next = value >>> 7
    bytes.push(next === 0 ? value : value | 0x80)
    value = next
  } while (value !== 0)
  return bytes
}
