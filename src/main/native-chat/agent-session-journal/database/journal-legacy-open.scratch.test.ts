// Scratch benchmark (never merged): the chat-store open that terminal restore waits on, at profile scale.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openJournalDatabase, runJournalTransaction } from './journal-database'
import {
  initializeJournalDomainDatabase,
  openJournalDomainDatabase
} from './journal-domain-database'
import { journalDatabasePath } from './journal-host-database'
import { insertJournalRow, publishJournalSessionEpoch } from '../durable-rows/journal-row-table'
import { journalSqlRetryRows } from '../journal-sql-retry-rows.test-fixture'
import { prepareJournalDomainImport } from '../journal-domain-import'
import {
  finishJournalDomainImport,
  insertJournalDomainImportPage
} from '../journal-domain-import-rows'
import type { JournalRow } from '../durable-rows/journal-row-schema'

const CHATS = Number(process.env.BENCH_CHATS ?? 18000)
const CONTINUED = Number(process.env.BENCH_CONTINUED ?? 7000)
const TURNS = Number(process.env.BENCH_TURNS ?? 40)
const rows = journalSqlRetryRows(false)
type ItemRow = Extract<JournalRow, { kind: 'item' }>
const savedTurn = rows.find(
  (row): row is ItemRow => row.kind === 'item' && row.itemId === 'failed'
)!
const tip = Math.max(...rows.map((row) => row.seq))
const turn = (itemId: string, seq: number): ItemRow => ({
  ...savedTurn,
  seq,
  itemId,
  body: { kind: 'turn', turnId: itemId, state: 'completed', outcome: 'success' }
})

it('times the chat-store open after an older Orca continued converted chats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-bench-'))
  try {
    const { db: original } = openJournalDatabase(journalDatabasePath(root))
    let at = performance.now()
    runJournalTransaction(original, () => {
      for (let index = 0; index < CHATS; index++) {
        const id = `chat-${index}`
        publishJournalSessionEpoch(
          original,
          { sessionId: id, workspaceId: `ws-${index % 1700}` },
          'epoch'
        )
        rows.forEach((row) => insertJournalRow(original, id, row))
        for (let t = 0; t < TURNS; t++) {
          insertJournalRow(original, id, turn(`t-${t}`, tip + 1 + t))
        }
        original
          .prepare('INSERT INTO agent_session_records VALUES(?,?)')
          .run(id, JSON.stringify({ sessionId: id, lease: { sessionId: id } }))
        if (index < 175) {
          original
            .prepare('INSERT INTO agent_session_tabs VALUES(?,?,?)')
            .run(`tab-${id}`, id, index)
        }
      }
    })
    original
      .prepare("INSERT INTO agent_session_store_meta VALUES('session_tabs_recorded','1')")
      .run()
    original.pragma('wal_checkpoint(TRUNCATE)')
    console.log(
      `BENCH seed original ${CHATS} chats x ${rows.length + TURNS} rows: ${(performance.now() - at).toFixed(0)} ms`
    )

    at = performance.now()
    const filename = await initializeJournalDomainDatabase(root)
    console.log(
      `BENCH first open (upgrade from older Orca): ${(performance.now() - at).toFixed(0)} ms`
    )

    at = performance.now()
    const { db } = openJournalDomainDatabase(filename)
    for (let index = 0; index < CONTINUED; index++) {
      const imported = prepareJournalDomainImport(original, `chat-${index}`)!
      const { pages, ...header } = imported
      for (const page of pages) {
        runJournalTransaction(db, () => insertJournalDomainImportPage(db, header, page))
      }
      runJournalTransaction(db, () => finishJournalDomainImport(db, header))
    }
    db.close()
    console.log(
      `BENCH convert ${CONTINUED} chats (setup): ${(performance.now() - at).toFixed(0)} ms`
    )

    at = performance.now()
    const steady = await initializeJournalDomainDatabase(root)
    console.log(`BENCH steady open, nothing written: ${(performance.now() - at).toFixed(0)} ms`)
    expect(steady).toBe(filename)

    // Downgrade: the older Orca continues every converted chat.
    runJournalTransaction(original, () => {
      for (let index = 0; index < CONTINUED; index++) {
        insertJournalRow(original, `chat-${index}`, turn('older-turn', tip + 1 + TURNS))
      }
    })
    original.pragma('wal_checkpoint(TRUNCATE)')
    original.close()

    at = performance.now()
    await initializeJournalDomainDatabase(root)
    const gate = performance.now() - at
    console.log(
      `BENCH open after older Orca continued ${CONTINUED} converted chats (terminal restore waits): ${gate.toFixed(0)} ms`
    )
    const check = openJournalDomainDatabase(filename).db
    console.log(
      `BENCH records after: ${JSON.stringify(check.prepare('SELECT COUNT(*) AS n FROM agent_session_records').get())}`
    )
    check.close()

    at = performance.now()
    await initializeJournalDomainDatabase(root)
    console.log(`BENCH next open: ${(performance.now() - at).toFixed(0)} ms`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 3_600_000)
