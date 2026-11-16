import { describe, expect, it } from 'vitest'
import { serialize } from 'node:v8'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'

const TERMINALS = Number(process.env.BENCH_TERMINALS ?? 300)
const DISPATCHES = Number(process.env.BENCH_DISPATCHES ?? 290)
const CALLS = Number(process.env.BENCH_CALLS ?? 200)

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

describe('orchestration reply bench', () => {
  it('times identical graph submissions', async () => {
    const runtime = new OrcaRuntimeService(store)
    const terminals = Array.from({ length: TERMINALS }, (_, index) => {
      const hex = index.toString(16).padStart(12, '0')
      return {
        tabId: `tab-${index}`,
        leafId: `11111111-1111-4111-8111-${hex}`,
        ptyId: `pty-${index}`,
        paneRuntimeId: index + 1
      }
    })
    const handles = terminals.map((t) => runtime.preAllocateHandleForPty(t.ptyId))
    const paneKey = (i: number) => makePaneKey(terminals[i].tabId, terminals[i].leafId)
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'bench',
      coordinatorHandle: handles[0],
      coordinatorPaneKey: paneKey(0)
    })
    for (let i = 1; i <= DISPATCHES && i < TERMINALS; i++) {
      const task = db.createTask({ spec: `w${i}`, runId: run.id })
      createRootDispatch(db, task.id, handles[i], paneKey(i))
    }
    runtime.setOrchestrationDb(db)
    runtime.attachWindow(1)
    let tick = 0
    const graph = (titleTick: boolean) => ({
      tabs: terminals.map((t, i) => ({
        tabId: t.tabId,
        worktreeId: TEST_WORKTREE_ID,
        title: titleTick && i === 1 ? `w-${tick}` : `w${i}`,
        activeLeafId: t.leafId,
        layout: null
      })),
      leaves: terminals.map((t) => ({
        tabId: t.tabId,
        worktreeId: TEST_WORKTREE_ID,
        leafId: t.leafId,
        paneRuntimeId: t.paneRuntimeId,
        ptyId: t.ptyId,
        paneTitle: null
      }))
    })
    const projection = (runtime as never as { agentOrchestrationProjection: { buildByPaneKey(): unknown } })
      .agentOrchestrationProjection
    const original = projection.buildByPaneKey.bind(projection)
    let buildMs = 0
    projection.buildByPaneKey = () => {
      const start = performance.now()
      try {
        return original()
      } finally {
        buildMs += performance.now() - start
      }
    }
    for (const titleTick of [false, true]) {
      for (let i = 0; i < 20; i++) {
        tick++
        await runtime.syncWindowGraph(1, graph(titleTick))
      }
      const totals: number[] = []
      const builds: number[] = []
      const serializeMs: number[] = []
      let rows = 0
      let bytes = 0
      for (let i = 0; i < CALLS; i++) {
        tick++
        const g = graph(titleTick)
        buildMs = 0
        const start = performance.now()
        const result = await runtime.syncWindowGraph(1, g)
        totals.push(performance.now() - start)
        builds.push(buildMs)
        const s = performance.now()
        bytes = serialize(result).byteLength
        serializeMs.push(performance.now() - s)
        rows = Object.keys(result.agentOrchestrationByPaneKey ?? {}).length
      }
      const sum = (v: number[]) => v.reduce((a, b) => a + b, 0)
      console.log(
        `BENCH ${titleTick ? 'title-tick' : 'identical'} terminals=${TERMINALS} rows=${rows} bytes=${bytes} ` +
          `handler p50=${pct(totals, 50).toFixed(2)} p95=${pct(totals, 95).toFixed(2)} mean=${(sum(totals) / CALLS).toFixed(2)} ` +
          `build p50=${pct(builds, 50).toFixed(2)} mean=${(sum(builds) / CALLS).toFixed(2)} ` +
          `serialize mean=${(sum(serializeMs) / CALLS).toFixed(2)}`
      )
      expect(rows).toBeGreaterThan(0)
    }
    db.close()
  }, 600_000)
})
