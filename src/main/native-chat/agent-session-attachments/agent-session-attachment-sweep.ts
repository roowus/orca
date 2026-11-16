// Claim checks and deletion marks arbitrate with sends in the same journal database.
// Retain claimed uploads while any recorded chat holds them; resume interrupted deletions on later sweeps.

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import { AGENT_SESSION_ATTACHMENT_PART_FILE } from './agent-session-attachment-references'
import { removeQuietly, type AgentSessionAttachmentStore } from './agent-session-attachment-store'
import {
  forgetKeptAgentSessionAttachment,
  keepAgentSessionAttachmentUpload,
  restoreKeptAgentSessionAttachments
} from './agent-session-attachment-kept-links'

export const ABANDONED_PART_MAX_AGE_MS = 60 * 60 * 1000
export const UNCLAIMED_ATTACHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type AgentSessionAttachmentSweepFacts = {
  listBeingSwept: () => readonly string[] | Promise<readonly string[]>
  markForSweep: (uploadId: string, now: number) => boolean | Promise<boolean>
  finishSweep: (uploadId: string) => void | Promise<void>
  pruneClaims: () => void | Promise<void>
  onUploadRemoved?: (uploadDir: string) => void
}

export type AgentSessionAttachmentSweepResult = { removed: string[] }

export async function sweepAgentSessionAttachments(
  store: AgentSessionAttachmentStore,
  facts: AgentSessionAttachmentSweepFacts,
  now = Date.now()
): Promise<AgentSessionAttachmentSweepResult> {
  const removed: string[] = []
  const remove = async (uploadId: string): Promise<void> => {
    const uploadDir = join(store.rootDir, uploadId)
    await removeQuietly(uploadDir)
    await forgetKeptAgentSessionAttachment(store.rootDir, uploadId)
    facts.onUploadRemoved?.(uploadDir)
  }
  for (const uploadId of await facts.listBeingSwept()) {
    await remove(uploadId)
    await facts.finishSweep(uploadId)
  }
  // Only after this build's own removals finish, so what is left to put back an older Orca removed.
  // Never in the way of sweeping: a filesystem without hard links just keeps nothing.
  await restoreKeptAgentSessionAttachments(store.rootDir).catch(() => {})
  for (const uploadId of await listDirectories(store.rootDir)) {
    if (store.isUploadInFlight(uploadId)) {
      continue
    }
    const uploadDir = join(store.rootDir, uploadId)
    const stored = (await readdir(uploadDir)).some(
      (entry) => entry !== AGENT_SESSION_ATTACHMENT_PART_FILE
    )
    const ageMs = now - (await modifiedAt(uploadDir))
    if (!stored) {
      if (ageMs > ABANDONED_PART_MAX_AGE_MS) {
        await remove(uploadId)
        removed.push(uploadDir)
      }
      continue
    }
    // Whichever lands first wins: claims retain uploads, sweep marks reject later claims.
    if (ageMs <= UNCLAIMED_ATTACHMENT_MAX_AGE_MS || !(await facts.markForSweep(uploadId, now))) {
      await keepAgentSessionAttachmentUpload(store.rootDir, uploadId).catch(() => {})
      continue
    }
    await remove(uploadId)
    await facts.finishSweep(uploadId)
    removed.push(uploadDir)
  }
  await facts.pruneClaims()
  return { removed }
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}

async function modifiedAt(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export type AgentSessionAttachmentSweeper = { stop: () => void }

/** Retry failed background sweeps without blocking host work. */
export function startAgentSessionAttachmentSweeps(
  store: AgentSessionAttachmentStore,
  facts: AgentSessionAttachmentSweepFacts,
  options: {
    initialDelayMs: number
    intervalMs: number
    onError: (error: unknown) => void
  }
): AgentSessionAttachmentSweeper {
  let running = false
  let stopped = false
  const run = (): void => {
    if (running || stopped) {
      return
    }
    running = true
    void sweepAgentSessionAttachments(store, facts)
      .catch(options.onError)
      .finally(() => {
        running = false
      })
  }
  const initial = setTimeout(run, options.initialDelayMs)
  const interval = setInterval(run, options.intervalMs)
  initial.unref?.()
  interval.unref?.()
  return {
    stop: () => {
      stopped = true
      clearTimeout(initial)
      clearInterval(interval)
    }
  }
}
