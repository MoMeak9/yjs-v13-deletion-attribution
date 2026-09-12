import assert from 'node:assert/strict'
import test from 'node:test'
import * as Y from 'yjs'
import {
  attributeDeletions,
  captureDeletionRecords,
  collectTransactionDeletions,
  encodeDeletionAttribution,
  type DeletionRange,
} from '../src/index.js'

test('captures only the declared, effective, already-known deletion', () => {
  const input = {
    beforeState: new Map([[10, 20]]),
    deleteSet: { clients: new Map([[10, [{ clock: 4, len: 3 }]]]) },
  }
  const claimed: DeletionRange[] = [{ client: 10, from: 4, to: 7 }]
  assert.deepEqual(captureDeletionRecords(input, claimed, 'bob'), [
    { client: 10, from: 4, to: 7, author: 'bob' },
  ])
  assert.deepEqual(
    captureDeletionRecords(
      { ...input, beforeState: new Map([[10, 4]]) },
      claimed,
      'bob'
    ),
    []
  )
})

test('maps a real Yjs tombstone to a zero-width current position', () => {
  const source = new Y.Doc()
  const sourceFragment = source.getXmlFragment('default')
  source.transact(() => {
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.push([new Y.XmlText('hello')])
    sourceFragment.push([paragraph])
  })

  const doc = new Y.Doc()
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source))
  const fragment = doc.getXmlFragment('default')
  let effective: DeletionRange[] = []
  doc.on('afterTransaction', transaction => {
    effective = collectTransactionDeletions(transaction)
  })
  doc.transact(() => {
    ;(fragment.get(0) as Y.XmlElement).get(0).delete(1, 2)
  })

  const records = effective.map(range => ({ ...range, author: 'bob' }))
  assert.deepEqual(attributeDeletions(doc, 'default', records, { isLeaf: () => false }), [
    { at: 2, author: 'bob' },
  ])
  assert.equal(
    encodeDeletionAttribution([{ at: 2, author: 'bob' }]),
    '{"kind":"ranges","ranges":[],"deletions":[{"at":2,"author":"bob"}]}'
  )
  source.destroy()
  doc.destroy()
})

test('keeps adjacent deletions by different users at one anchor', () => {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('default')
  doc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.push([new Y.XmlText('abcdef')])
    fragment.push([paragraph])
  })
  const text = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText
  const ranges: DeletionRange[][] = []
  doc.on('afterTransaction', transaction => ranges.push(collectTransactionDeletions(transaction)))
  doc.transact(() => text.delete(2, 2))
  const first = ranges[0]
  doc.transact(() => text.delete(2, 2))
  const second = ranges[1]
  const marks = attributeDeletions(doc, 'default', [
    { ...first[0], author: 'bob' },
    { ...second[0], author: 'carol' },
  ])
  assert.deepEqual(marks, [
    { at: 3, author: 'bob' },
    { at: 3, author: 'carol' },
  ])
  doc.destroy()
})
