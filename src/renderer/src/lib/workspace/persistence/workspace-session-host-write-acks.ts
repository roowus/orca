import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { jsonContentEquals } from '../../../runtime/sync-runtime-graph/graph-state'

/** Field values each host partition last acknowledged from this window's debounced writes. */
export type HostSessionWriteAcks = {
  /** True when every field in the slice already matches what this host acknowledged. */
  matches: (hostId: ExecutionHostId, slice: WorkspaceSessionState) => boolean
  record: (hostId: ExecutionHostId, slice: WorkspaceSessionState) => void
  forget: (hostId: ExecutionHostId) => void
}

export function createHostSessionWriteAcks(): HostSessionWriteAcks {
  const fieldsByHostId = new Map<ExecutionHostId, Map<string, unknown>>()
  return {
    matches: (hostId, slice) => {
      const acked = fieldsByHostId.get(hostId)
      if (!acked) {
        return false
      }
      // Key presence matters: a patch key holding undefined clears the stored field.
      return Object.entries(slice).every(
        ([field, value]) => acked.has(field) && jsonContentEquals(acked.get(field), value)
      )
    },
    record: (hostId, slice) => {
      const acked = fieldsByHostId.get(hostId) ?? new Map<string, unknown>()
      for (const [field, value] of Object.entries(slice)) {
        acked.set(field, value)
      }
      fieldsByHostId.set(hostId, acked)
    },
    forget: (hostId) => {
      fieldsByHostId.delete(hostId)
    }
  }
}
