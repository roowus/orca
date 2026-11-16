import type Database from '../../../sqlite/sync-database'
import { prepareJournalDomainImport } from '../journal-domain-import'

/**
 * Pending a product call (tracked in #42783). When true, a chat an older Orca only added
 * bookkeeping to (CI lines, recovery and queue marks, roster updates) takes its new state as the
 * baseline, and those lines stay only in the original journal. When false, any change it made is
 * kept as a message would be: a converted chat gets a copy, and a chat closed here comes back.
 */
export const OLDER_ORCA_KEEPS_ONLY_MESSAGES = true

/**
 * Where this file last read an original chat: past it, every write is the older Orca's own. From a
 * saved revision the original's own sequence numbers say so exactly; items saved as outcome
 * records carry the same sequence. Files copied before revisions were kept have none: a converted
 * chat then compares against what it holds here, and any other against when the original was
 * last read, by the time each item was saved.
 */
export type OlderMessageCursor =
  | { kind: 'revision'; epoch: string; tip: number; through: number; heldEpoch?: string }
  | { kind: 'held'; epoch: string }
  | { kind: 'time'; after: number }

export function olderMessageCursor(
  revision: string | undefined,
  heldEpoch: string | null,
  lastRead: number | null
): OlderMessageCursor | null {
  const saved = parseRevision(revision)
  if (saved?.kind === 'revision' && heldEpoch !== null) {
    return { ...saved, heldEpoch }
  }
  return (
    saved ??
    (heldEpoch !== null
      ? { kind: 'held', epoch: heldEpoch }
      : lastRead !== null
        ? { kind: 'time', after: lastRead }
        : null)
  )
}

/**
 * Whether the older Orca added a real user or agent message past the cursor: a send, agent output,
 * or text queued to send. Uncertain is "added", so its text is kept, never taken as shown here.
 */
export function olderOrcaAddedMessages(
  source: Database.Database,
  db: Database.Database,
  id: string,
  cursor: OlderMessageCursor,
  revision: string
): boolean {
  if (!OLDER_ORCA_KEEPS_ONLY_MESSAGES) {
    return true
  }
  if (cursor.kind !== 'revision') {
    return addedBesideHeld(source, db, id, cursor)
  }
  // A tip or coverage behind the revision read here is another history (a restored backup):
  // nothing past the revision says what it holds.
  const current = parseRevision(revision)
  if (
    current?.kind === 'revision' &&
    current.epoch === cursor.epoch &&
    (current.tip < cursor.tip || current.through < cursor.through)
  ) {
    return true
  }
  return addedPastRevision(source, db, id, cursor)
}

/**
 * Reads only what the original saved past the revision, row by row: an input row, or an outcome
 * record of an item or a queued card. A sent message's own item is how a send counts here.
 */
function addedPastRevision(
  source: Database.Database,
  db: Database.Database,
  id: string,
  cursor: Extract<OlderMessageCursor, { kind: 'revision' }>
): boolean {
  const session = source.prepare('SELECT epoch FROM journal_sessions WHERE session_id=?').get(id)
  if (!session) {
    return false
  }
  const epoch = String(session.epoch)
  // A re-founded epoch starts its sequence over: everything in it is new.
  const past = epoch === cursor.epoch ? cursor.through : -1
  for (const { row_json: row } of source
    .prepare(
      'SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq>? ORDER BY seq'
    )
    .iterate(id, epoch, past)) {
    if (rowAddsMessage(parseJson(row))) {
      return true
    }
  }
  const outcomes = source
    .prepare('SELECT generation FROM journal_outcome_epochs WHERE session_id=? AND epoch=?')
    .get(id, epoch)
  if (!outcomes) {
    return false
  }
  for (const { field, value_json: value } of source
    .prepare(`SELECT field, value_json FROM journal_outcomes WHERE generation=? AND seq>?
      AND deleted=0 AND field IN ('items','queue.cards') ORDER BY seq`)
    .iterate(outcomes.generation, past)) {
    const parsed = parseJson(value)
    // A card is stored keyed, as `[messageId, card]`.
    const card = Array.isArray(parsed) ? parsed[1] : undefined
    if (
      field === 'items'
        ? isRealMessage(parsed) &&
          !shownBefore(source, db, id, cursor, outcomes.generation, past, parsed)
        : queuedPast(card, epoch, past)
    ) {
      return true
    }
  }
  return false
}

function rowAddsMessage(row: unknown): boolean {
  if (!isObject(row) || row.recovered === true) {
    return false
  }
  switch (row.kind) {
    case 'submission':
      return true
    case 'item':
      return isRealMessage(row)
    case 'lifecycle-batch':
      return Array.isArray(row.mutations) && row.mutations.some(isRealMessage)
    case 'queue':
      // Typed text queued to send; a card coming back after a failed send was queued before.
      return (
        isObject(row.change) &&
        row.change.op === 'queued' &&
        row.change.returned === undefined &&
        row.change.recovers === undefined
      )
    default:
      return false
  }
}

/**
 * An outcome record rewrites a whole item, so one past the revision can be a message already
 * there that an open moved (a send it set back as unsent keeps its text and revision).
 */
function shownBefore(
  source: Database.Database,
  db: Database.Database,
  id: string,
  cursor: Extract<OlderMessageCursor, { kind: 'revision' }>,
  generation: unknown,
  past: number,
  item: unknown
): boolean {
  if (!isHeldShape(item)) {
    return false
  }
  const prior = source
    .prepare(`SELECT value_json FROM journal_outcomes WHERE generation=? AND field='items'
      AND entry_key=? AND seq<=? ORDER BY seq DESC LIMIT 1`)
    .get(generation, JSON.stringify(item.itemId), past)
  const before = prior === undefined ? undefined : parseJson(prior.value_json)
  return (
    (isObject(before) && sameBody(before.body, item.body)) ||
    (cursor.heldEpoch !== undefined && heldItem(db, id, cursor.heldEpoch, item, 'or-later'))
  )
}

/** A card records the sequence it was queued after, so one queued right past the revision is new. */
function queuedPast(card: unknown, epoch: string, past: number): boolean {
  return (
    isObject(card) &&
    (card.state === 'waiting' || card.state === 'returned') &&
    isObject(card.queuedAt) &&
    (card.queuedAt.epoch !== epoch || Number(card.queuedAt.sequence) >= past)
  )
}

/**
 * Without a revision, the chat's whole restored history is compared: with what a converted chat
 * holds here, or with when the original was last read.
 */
function addedBesideHeld(
  source: Database.Database,
  db: Database.Database,
  id: string,
  cursor: Exclude<OlderMessageCursor, { kind: 'revision' }>
): boolean {
  const imported = prepareJournalDomainImport(source, id)
  if (!imported) {
    return false
  }
  const held = (table: string, key: string): boolean =>
    cursor.kind === 'held' &&
    db
      .prepare(`SELECT 1 FROM ${table} WHERE session_id=? AND epoch=? AND message_id=? LIMIT 1`)
      .get(id, cursor.epoch, key) !== undefined
  // A card is held only with the same text: one edited there is the person's newer text.
  const heldCard = (card: { messageId: string; body: unknown }): boolean => {
    if (cursor.kind !== 'held') {
      return false
    }
    const row = db
      .prepare(
        'SELECT payload_json AS payload FROM journal_queue_cards WHERE session_id=? AND epoch=? AND message_id=?'
      )
      .get(id, cursor.epoch, card.messageId)
    const payload = row === undefined ? undefined : parseJson(row.payload)
    return isObject(payload) && sameBody(payload.body, card.body)
  }
  for (const page of imported.pages) {
    if (page.kind === 'items') {
      for (const { item } of page.rows) {
        if (
          isRealMessage(item) &&
          (cursor.kind === 'held'
            ? !heldItem(db, id, cursor.epoch, item)
            : item.observedAt > cursor.after)
        ) {
          return true
        }
      }
    } else if (cursor.kind === 'time') {
      // Only items carry a time; a send the older Orca accepted shows as its message item.
      continue
    } else if (page.kind === 'attempts') {
      if (
        page.rows.some(
          ({ submission }) => !held('journal_submission_attempts', submission.clientMessageId)
        )
      ) {
        return true
      }
    } else if (page.kind === 'cards') {
      if (
        page.rows.some(
          (card) => (card.state === 'waiting' || card.state === 'returned') && !heldCard(card)
        )
      ) {
        return true
      }
    }
  }
  return false
}

/** CI lines and other status rows, turn edges and the rows an open rewrites on its own aren't. */
function isRealMessage(item: unknown): boolean {
  if (!isObject(item) || item.recovered === true || !isObject(item.body)) {
    return false
  }
  switch (item.body.kind) {
    case 'message':
      return item.body.role !== 'system'
    case 'tool-call':
    case 'diff':
    case 'approval':
    case 'question':
      return true
    default:
      return false
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: unknown): unknown {
  try {
    return JSON.parse(String(text))
  } catch {
    return undefined
  }
}

/** Held only as the same revision of the same item, or removed here; anything else may diverge. */
function heldItem(
  db: Database.Database,
  id: string,
  epoch: string,
  item: HeldShape,
  revision: 'same' | 'or-later' = 'same'
): boolean {
  const row = db
    .prepare(`SELECT revision, payload_json AS payload FROM journal_items
      WHERE session_id=?1 AND epoch=?2 AND item_id=?3
      UNION ALL SELECT NULL, NULL FROM journal_item_tombstones
      WHERE session_id=?1 AND epoch=?2 AND item_id=?3`)
    .get(id, epoch, item.itemId)
  if (!row) {
    return false
  }
  if (row.revision === null) {
    return true
  }
  const held = Number(row.revision)
  if (revision === 'same' ? held !== item.revision : held < item.revision) {
    return false
  }
  const payload = parseJson(row.payload)
  return isObject(payload) && sameBody(payload.body, item.body)
}

type HeldShape = { itemId: string; revision: number; body: unknown }

function isHeldShape(item: unknown): item is HeldShape {
  return isObject(item) && typeof item.itemId === 'string' && typeof item.revision === 'number'
}

function sameBody(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** A revision is `[epoch, input tip, outcome generation, outcome coverage]`; `null` had no history. */
function parseRevision(revision: string | undefined): OlderMessageCursor | null {
  if (revision === undefined) {
    return null
  }
  if (revision === 'null') {
    return { kind: 'revision', epoch: '', tip: 0, through: 0 }
  }
  try {
    const parsed: unknown = JSON.parse(revision)
    if (!Array.isArray(parsed)) {
      return null
    }
    const [epoch, tip, , through] = parsed
    return typeof epoch === 'string' && typeof tip === 'number'
      ? {
          kind: 'revision',
          epoch,
          tip,
          through: Math.max(tip, typeof through === 'number' ? through : 0)
        }
      : null
  } catch {
    return null
  }
}
