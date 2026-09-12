import * as Y from 'yjs'
import type { DeletionRange } from './index.js'

export const SYNC_STEP_1 = 0
export const SYNC_STEP_2 = 1
export const SYNC_UPDATE = 2

export interface SyncFrame {
  readonly syncType: number
  readonly claimedDeletions: readonly DeletionRange[]
}

/**
 * Decode the Hocuspocus/y-protocols sync envelope and extract the DeleteSet
 * declared by a realtime SYNC_UPDATE. SyncStep2 deliberately returns an empty
 * claim because it is state replay and cannot be attributed to its connection.
 */
export function decodeSyncFrame(data: Uint8Array): SyncFrame | null {
  const reader = new Reader(data)
  if (reader.readVarBytes() === null) return null // document name
  if (reader.readVarUint() !== 0) return null // MessageType.Sync
  const syncType = reader.readVarUint()
  if (syncType === null) return null
  const payload = reader.readVarBytes()
  if (payload === null) return null
  if (syncType !== SYNC_UPDATE) return { syncType, claimedDeletions: [] }

  try {
    const ranges: DeletionRange[] = []
    Y.decodeUpdate(payload).ds.clients.forEach((entries, client) => {
      for (const entry of entries) {
        ranges.push({ client, from: entry.clock, to: entry.clock + entry.len })
      }
    })
    return { syncType, claimedDeletions: ranges }
  } catch {
    return null
  }
}

class Reader {
  private offset = 0

  constructor(private readonly data: Uint8Array) {}

  readVarUint(): number | null {
    let value = 0
    let shift = 0
    for (let i = 0; i < 5; i++) {
      const byte = this.data[this.offset++]
      if (byte === undefined) return null
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return value
      shift += 7
    }
    return null
  }

  readVarBytes(): Uint8Array | null {
    const length = this.readVarUint()
    if (length === null || length > this.data.length - this.offset) return null
    const value = this.data.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }
}
