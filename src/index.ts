import * as Y from 'yjs'

/** A half-open Yjs clock interval. `client` identifies the deleted content. */
export interface DeletionRange {
  readonly client: number
  readonly from: number
  readonly to: number
}

/** A deletion range plus the user who caused it. */
export interface DeletionRecord extends DeletionRange {
  readonly author: string
}

/** A zero-width mark in the current document coordinate space. */
export interface DeletionMark {
  readonly at: number
  readonly author: string
}

export interface DeletionCaptureInput {
  readonly beforeState: ReadonlyMap<number, number>
  readonly deleteSet: {
    readonly clients: ReadonlyMap<
      number,
      readonly { readonly clock: number; readonly len: number }[]
    >
  }
}

/** Flatten a Yjs transaction DeleteSet into stable clock intervals. */
export function collectTransactionDeletions(
  transaction: DeletionCaptureInput
): DeletionRange[] {
  const ranges: DeletionRange[] = []
  for (const [client, entries] of transaction.deleteSet.clients) {
    for (const entry of entries) {
      ranges.push({ client, from: entry.clock, to: entry.clock + entry.len })
    }
  }
  return ranges
}

/** Keep only ranges declared by this frame and actually deleted by this transaction. */
export function intersectDeletions(
  claimed: readonly DeletionRange[],
  effective: readonly DeletionRange[]
): DeletionRange[] {
  const result: DeletionRange[] = []
  for (const one of effective) {
    for (const other of claimed) {
      if (one.client !== other.client) continue
      const from = Math.max(one.from, other.from)
      const to = Math.min(one.to, other.to)
      if (from < to) result.push({ client: one.client, from, to })
    }
  }
  return result
}

/** Reject deletes whose target structs arrived in the same transaction. */
export function carriesOnlyKnownDeletions(
  input: DeletionCaptureInput
): boolean {
  for (const [client, ranges] of input.deleteSet.clients) {
    const known = input.beforeState.get(client) ?? 0
    for (const range of ranges) {
      if (range.clock + range.len > known) return false
    }
  }
  return true
}

/**
 * Produce records for one inbound frame/transaction pair.
 * Return an empty array when the frame cannot be safely attributed.
 */
export function captureDeletionRecords(
  input: DeletionCaptureInput,
  claimed: readonly DeletionRange[],
  author: string
): DeletionRecord[] {
  if (!author) return []
  if (!carriesOnlyKnownDeletions(input)) return []
  return intersectDeletions(claimed, collectTransactionDeletions(input)).map(
    range => ({ ...range, author })
  )
}

export interface AttributeDeletionsOptions {
  /** Return true for schema leaf nodes (`nodeSize === 1` in ProseMirror). */
  readonly isLeaf?: (nodeName: string) => boolean
}

interface ItemLike {
  deleted: boolean
  id: { client: number; clock: number }
  right: ItemLike | null
  content: { getLength(): number; getContent?(): unknown[] }
}

function startOf(value: object): ItemLike | null {
  return (value as { _start: ItemLike | null })._start
}

function values(item: ItemLike): unknown[] {
  return item.content.getContent?.() ?? []
}

function intersects(item: ItemLike, record: DeletionRecord): boolean {
  if (item.id.client !== record.client) return false
  const end = item.id.clock + item.content.getLength()
  return record.from < end && record.to > item.id.clock
}

function appendMarks(
  item: ItemLike,
  position: number,
  records: readonly DeletionRecord[],
  output: DeletionMark[]
): void {
  for (const record of records) {
    if (!intersects(item, record)) continue
    if (output.some(mark => mark.at === position && mark.author === record.author)) continue
    output.push({ at: position, author: record.author })
  }
}

/**
 * Match externally captured clock ranges to Yjs tombstones.
 *
 * Yjs intentionally does not retain the deleting user's identity in a tombstone.
 * This function therefore accepts the records captured at transaction time and
 * only uses the document to recover the current zero-width position.
 */
export function attributeDeletions(
  doc: Y.Doc,
  fragmentName: string,
  records: readonly DeletionRecord[],
  options: AttributeDeletionsOptions = {}
): DeletionMark[] {
  const marks: DeletionMark[] = []
  let position = 0
  const isLeaf = options.isLeaf ?? (() => false)

  const walk = (element: Y.XmlFragment | Y.XmlElement): void => {
    let item = startOf(element)
    while (item) {
      if (item.deleted) {
        appendMarks(item, position, records, marks)
        item = item.right
        continue
      }

      for (const child of values(item)) {
        if (child instanceof Y.XmlText) {
          let textItem = startOf(child)
          while (textItem) {
            if (textItem.deleted) appendMarks(textItem, position, records, marks)
            position += textItem.deleted ? 0 : textItem.content.getLength()
            textItem = textItem.right
          }
        } else if (child instanceof Y.XmlElement) {
          if (isLeaf(child.nodeName)) {
            position += 1
          } else {
            position += 1
            walk(child)
            position += 1
          }
        } else {
          position += 1
        }
      }
      item = item.right
    }
  }

  walk(doc.getXmlFragment(fragmentName))
  return marks
}

export function encodeDeletionAttribution(marks: readonly DeletionMark[]): string | null {
  return marks.length === 0
    ? null
    : JSON.stringify({ kind: 'ranges', ranges: [], deletions: marks })
}
