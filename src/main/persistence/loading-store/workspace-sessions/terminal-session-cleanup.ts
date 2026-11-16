import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../../shared/workspace-session/workspace-session-state-types'
import {
  collectTerminalScrollbackSnapshotRefs,
  deleteTerminalScrollbackSnapshotSync,
  type TerminalScrollbackSnapshotStorage
} from '../../../pty/scrollback/terminal-scrollback-snapshots'
import { terminalTabsDifferOnlyInPresentation } from '../../../../shared/workspace-layout/terminal-topology/terminal-tab-presentation-change'

// Exclude local-only scrollback: normalization lacks renderer attribution and would strip valid leaf buffers.
const WORKSPACE_SESSION_PATCH_FULL_NORMALIZATION_KEYS = new Set<keyof WorkspaceSessionState>([
  'tabsByWorktree',
  'terminalLayoutsByTabId'
])

export function workspaceSessionPatchNeedsFullNormalization(
  patch: WorkspaceSessionPatch,
  /** The partition the patch merges into; given, a labels-only tab patch keeps its normalized topology. */
  existing?: WorkspaceSessionState
): boolean {
  if (
    !Object.keys(patch).some((key) =>
      WORKSPACE_SESSION_PATCH_FULL_NORMALIZATION_KEYS.has(key as keyof WorkspaceSessionState)
    )
  ) {
    return false
  }
  // Same tabs, order and bindings as the stored (already normalized) rows: normalization has nothing to rebase.
  return !(
    existing?.tabsByWorktree &&
    patch.tabsByWorktree &&
    !Object.hasOwn(patch, 'terminalLayoutsByTabId') &&
    terminalTabsDifferOnlyInPresentation(existing.tabsByWorktree, patch.tabsByWorktree)
  )
}

export function deleteRemovedTerminalScrollbackSnapshots(
  prior: WorkspaceSessionState | undefined,
  next: WorkspaceSessionState,
  storage?: TerminalScrollbackSnapshotStorage,
  /** Pending migration exports retain refs even after their session rows disappear. */
  retainedRefs: ReadonlySet<string> = new Set()
): void {
  if (!prior) {
    return
  }
  const nextRefs = collectTerminalScrollbackSnapshotRefs(next)
  for (const ref of collectTerminalScrollbackSnapshotRefs(prior)) {
    if (!nextRefs.has(ref) && !retainedRefs.has(ref)) {
      deleteTerminalScrollbackSnapshotSync(ref, storage)
    }
  }
}
