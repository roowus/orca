// An older Orca sweeps this store's root by its own claims, which never include uploads saved here.
// A second hard link outside that root keeps their bytes, and puts back any folder it removed.

import { link, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { AGENT_SESSION_ATTACHMENT_PART_FILE } from './agent-session-attachment-references'

/** A sibling of the store root, so no older sweep of that root ever visits it. */
export function agentSessionAttachmentKeptRoot(storeRoot: string): string {
  return `${storeRoot}-kept`
}

/** Links each committed file of one upload into the kept root; a failure retries next sweep. */
export async function keepAgentSessionAttachmentUpload(
  storeRoot: string,
  uploadId: string
): Promise<void> {
  const files = (await entries(join(storeRoot, uploadId))).filter(
    (name) => name !== AGENT_SESSION_ATTACHMENT_PART_FILE
  )
  if (files.length > 0) {
    await linkMissing(
      join(storeRoot, uploadId),
      join(agentSessionAttachmentKeptRoot(storeRoot), uploadId),
      files
    )
  }
}

/**
 * Puts back every kept file missing from its upload folder. A file, not its folder, says what is
 * there: an older sweep stopped partway leaves the folder behind empty.
 */
export async function restoreKeptAgentSessionAttachments(storeRoot: string): Promise<void> {
  const keptRoot = agentSessionAttachmentKeptRoot(storeRoot)
  for (const uploadId of await entries(keptRoot)) {
    try {
      const files = await entries(join(keptRoot, uploadId))
      await (files.length === 0
        ? forgetKeptAgentSessionAttachment(storeRoot, uploadId)
        : linkMissing(join(keptRoot, uploadId), join(storeRoot, uploadId), files))
    } catch {
      // Retried at the next sweep; one upload never holds back the rest.
    }
  }
}

/** Best effort: a leftover kept folder is put back and swept again later. */
export async function forgetKeptAgentSessionAttachment(
  storeRoot: string,
  uploadId: string
): Promise<void> {
  await rm(join(agentSessionAttachmentKeptRoot(storeRoot), uploadId), {
    recursive: true,
    force: true
  }).catch(() => {})
}

async function linkMissing(from: string, to: string, files: readonly string[]): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const name of files) {
    try {
      await link(join(from, name), join(to, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  }
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}
