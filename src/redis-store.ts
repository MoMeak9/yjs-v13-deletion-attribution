import type { DeletionRecord, DeletionStore } from './index.js'

/** Minimal ioredis/node-redis compatible surface used by RedisDeletionStore. */
export interface RedisEvalClient {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>
}

export interface RedisDeletionStoreOptions {
  /** Redis key prefix. Defaults to `deletions:`. */
  readonly keyPrefix?: string
  /** Retention for unclaimed records. Defaults to one day. */
  readonly ttlSeconds?: number
  /** Maximum records retained per document. Defaults to 5000. */
  readonly maxRecords?: number
}

const APPEND_SCRIPT = `
local ttl = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
for i = 3, #ARGV do
  redis.call('RPUSH', KEYS[1], ARGV[i])
end
redis.call('LTRIM', KEYS[1], -max, -1)
redis.call('EXPIRE', KEYS[1], ttl)
return 1
`

const CLAIM_SCRIPT = `
local values = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1])
return values
`

const RESTORE_SCRIPT = `
local ttl = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
for i = #ARGV, 3, -1 do
  redis.call('LPUSH', KEYS[1], ARGV[i])
end
redis.call('LTRIM', KEYS[1], -max, -1)
redis.call('EXPIRE', KEYS[1], ttl)
return 1
`

/** Redis-backed deletion records with atomic claim/restore operations. */
export class RedisDeletionStore implements DeletionStore {
  private readonly prefix: string
  private readonly ttlSeconds: number
  private readonly maxRecords: number
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(
    private readonly redis: RedisEvalClient,
    options: RedisDeletionStoreOptions = {}
  ) {
    this.prefix = options.keyPrefix ?? 'deletions:'
    this.ttlSeconds = options.ttlSeconds ?? 24 * 60 * 60
    this.maxRecords = options.maxRecords ?? 5000
    if (!Number.isInteger(this.ttlSeconds) || this.ttlSeconds <= 0) {
      throw new RangeError('ttlSeconds must be a positive integer')
    }
    if (!Number.isInteger(this.maxRecords) || this.maxRecords <= 0) {
      throw new RangeError('maxRecords must be a positive integer')
    }
  }

  append(documentId: string, records: readonly DeletionRecord[]): Promise<void> {
    if (records.length === 0) return Promise.resolve()
    return this.enqueue(documentId, async () => {
      await this.redis.eval(APPEND_SCRIPT, 1, this.key(documentId), String(this.ttlSeconds), String(this.maxRecords), ...records.map(encode))
    })
  }

  claim(documentId: string): Promise<DeletionRecord[]> {
    return this.enqueue(documentId, async () => {
      const raw = await this.redis.eval(CLAIM_SCRIPT, 1, this.key(documentId))
      return decodeMany(raw)
    })
  }

  restore(documentId: string, records: readonly DeletionRecord[]): Promise<void> {
    if (records.length === 0) return Promise.resolve()
    return this.enqueue(documentId, async () => {
      await this.redis.eval(RESTORE_SCRIPT, 1, this.key(documentId), String(this.ttlSeconds), String(this.maxRecords), ...records.map(encode))
    })
  }

  private key(documentId: string): string {
    return `${this.prefix}${documentId}`
  }

  private enqueue<T>(documentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(documentId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.pending.set(documentId, current)
    void current.then(
      () => this.clearPending(documentId, current),
      () => this.clearPending(documentId, current)
    )
    return current
  }

  private clearPending(documentId: string, entry: Promise<unknown>): void {
    if (this.pending.get(documentId) === entry) this.pending.delete(documentId)
  }
}

function encode(record: DeletionRecord): string {
  return JSON.stringify({ c: record.client, f: record.from, t: record.to, a: record.author })
}

function decodeMany(value: unknown): DeletionRecord[] {
  if (!Array.isArray(value)) return []
  const records: DeletionRecord[] = []
  for (const item of value) {
    try {
      const parsed = JSON.parse(String(item)) as { c?: unknown; f?: unknown; t?: unknown; a?: unknown }
      const client = parsed.c
      const from = parsed.f
      const to = parsed.t
      if (typeof client === 'number' && Number.isInteger(client) && typeof from === 'number' && Number.isInteger(from) && typeof to === 'number' && Number.isInteger(to) && from < to && typeof parsed.a === 'string' && parsed.a !== '') {
        records.push({ client, from, to, author: parsed.a })
      }
    } catch {
      // Ignore malformed records; one bad Redis entry must not block a snapshot.
    }
  }
  return records
}
