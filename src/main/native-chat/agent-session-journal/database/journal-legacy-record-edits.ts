import type Database from '../../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'
import {
  openJournalLegacySource,
  readJournalStoreMeta,
  writeJournalStoreMeta
} from './journal-legacy-source'

/** Set once every original chat's person edits have a baseline here. */
export const JOURNAL_LEGACY_PERSON_EDITS_KEPT = 'journal.legacy-person-edits-kept.v1'

/**
 * What a person edits on a chat's record, each group taken whole. An older build rewrites every
 * record's lease and `updatedAt` at launch, so only these fields, compared with what this file
 * last read from the original, say the older build was used to edit the chat.
 */
const PERSON_EDITS = [
  ['conversationName', 'conversationNameSource'],
  ['options'],
  ['permissionMode']
]
const PERSON_FIELDS = PERSON_EDITS.flat()
const PERSON_EDITS_SQL = `CASE WHEN json_valid(record_json) THEN json_extract(record_json,
  ${PERSON_FIELDS.map((field) => `'$.${field}'`).join(',')}) END`

function personEditsKey(sessionId: string): string {
  return `journal.legacy-person-edits:${sessionId}`
}

/** The original's person edits for every chat, as the baseline later launches compare with. */
export function recordJournalLegacyPersonEdits(
  source: Database.Database,
  db: Database.Database
): void {
  for (const row of source
    .prepare(`SELECT session_id, ${PERSON_EDITS_SQL} AS edits FROM agent_session_records`)
    .iterate()) {
    if (typeof row.edits === 'string') {
      writeJournalStoreMeta(db, personEditsKey(String(row.session_id)), row.edits)
    }
  }
}

/**
 * Once, for a file kept before person edits were: the original is as last read, so its edits are
 * exactly the baseline a later downgrade's renames compare with.
 */
export function keepJournalLegacyPersonEdits(sourcePath: string, db: Database.Database): void {
  if (readJournalStoreMeta(db, JOURNAL_LEGACY_PERSON_EDITS_KEPT) !== undefined) {
    return
  }
  const source = openJournalLegacySource(sourcePath)
  try {
    runJournalTransaction(db, () => {
      recordJournalLegacyPersonEdits(source, db)
      writeJournalStoreMeta(db, JOURNAL_LEGACY_PERSON_EDITS_KEPT, '1')
    })
  } finally {
    source.close()
  }
}

/** Takes the edits a person made to a chat's record in the older Orca since this file last read it. */
export function absorbOlderOrcaRecordEdits(
  source: Database.Database,
  db: Database.Database,
  sessionId: string
): void {
  const edited = olderOrcaPersonEdits(source, db, sessionId)
  if (!edited) {
    return
  }
  const current = recordHere(db, sessionId)
  if (current) {
    const next = withFields(current, edited.older, edited.changed)
    if (next !== current) {
      db.prepare('UPDATE agent_session_records SET record_json=? WHERE session_id=?').run(
        JSON.stringify(next),
        sessionId
      )
    }
  }
  writeJournalStoreMeta(db, personEditsKey(sessionId), edited.edits)
}

/**
 * The older build's record for a chat it added messages to, as the build that ran it last, keeping
 * this file's person edits wherever the older build left them as this file last read them.
 */
export function olderOrcaRecordKeepingEditsHere(
  source: Database.Database,
  db: Database.Database,
  sessionId: string,
  original: string
): string {
  const older = parseRecord(original)
  const current = recordHere(db, sessionId)
  const edited = olderOrcaPersonEdits(source, db, sessionId)
  if (edited) {
    writeJournalStoreMeta(db, personEditsKey(sessionId), edited.edits)
  }
  if (!older || !current) {
    return original
  }
  const unchanged = PERSON_FIELDS.filter((field) => !edited?.changed.has(field))
  return JSON.stringify(withFields(older, current, new Set(unchanged)))
}

/** Which person-edit fields the older build changed since this file last read the original. */
function olderOrcaPersonEdits(
  source: Database.Database,
  db: Database.Database,
  sessionId: string
): { edits: string; older: Record<string, unknown>; changed: Set<string> } | null {
  const row = source
    .prepare(`SELECT ${PERSON_EDITS_SQL} AS edits FROM agent_session_records WHERE session_id=?`)
    .get(sessionId)
  if (typeof row?.edits !== 'string') {
    return null
  }
  const edits = row.edits
  const saved = readJournalStoreMeta(db, personEditsKey(sessionId))
  const older = fieldsOf(edits)
  const changed = new Set<string>()
  // With no baseline nothing says which build changed a field, so this file's value stays.
  if (saved !== undefined && saved !== edits) {
    const before = fieldsOf(saved)
    for (const group of PERSON_EDITS) {
      if (group.some((field) => !same(before[field], older[field]))) {
        group.forEach((field) => changed.add(field))
      }
    }
  }
  return { edits, older, changed }
}

/** `onto` with `from`'s value for each named field; the same object when nothing changes. */
function withFields(
  onto: Record<string, unknown>,
  from: Record<string, unknown>,
  fields: ReadonlySet<string>
): Record<string, unknown> {
  // Automatic naming never replaces a person's name, as in either build itself.
  const keepName = onto.conversationNameSource === 'user' && from.conversationNameSource !== 'user'
  const next: Record<string, unknown> = { ...onto }
  let changed = false
  for (const field of fields) {
    if ((keepName && field.startsWith('conversationName')) || same(onto[field], from[field])) {
      continue
    }
    if (from[field] === undefined || from[field] === null) {
      delete next[field]
    } else {
      next[field] = from[field]
    }
    changed = true
  }
  return changed ? next : onto
}

function recordHere(db: Database.Database, sessionId: string): Record<string, unknown> | null {
  const row = db
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
    .get(sessionId)
  return row === undefined ? null : parseRecord(String(row.record_json))
}

function fieldsOf(edits: string): Record<string, unknown> {
  const values = parseJson(edits)
  return Array.isArray(values)
    ? Object.fromEntries(PERSON_FIELDS.map((field, index) => [field, values[index] ?? undefined]))
    : {}
}

function parseRecord(json: string): Record<string, unknown> | null {
  const value = parseJson(json)
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}
