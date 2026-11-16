import type { TerminalTab } from '../terminal-tab-types'

// Saved labels and color; layouts, scrollback homes, bindings and reconnect targets never read them.
const TERMINAL_TAB_PRESENTATION_KEYS: ReadonlySet<string> = new Set<keyof TerminalTab>([
  'title',
  'defaultTitle',
  'generatedTitle',
  'aiVaultTitle',
  'quickCommandLabel',
  'customTitle',
  'color'
])

const NO_KEYS: ReadonlySet<string> = new Set()

/** True when both maps hold the same tabs in the same order and differ only in presentation keys (and `ignoredKeys`). */
export function terminalTabsDifferOnlyInPresentation(
  prev: Readonly<Record<string, readonly TerminalTab[]>>,
  next: Readonly<Record<string, readonly TerminalTab[]>>,
  ignoredKeys: ReadonlySet<string> = NO_KEYS
): boolean {
  const worktreeIds = Object.keys(next)
  if (worktreeIds.length !== Object.keys(prev).length) {
    return false
  }
  for (const worktreeId of worktreeIds) {
    const prevTabs = prev[worktreeId]
    const nextTabs = next[worktreeId]
    if (prevTabs === nextTabs) {
      continue
    }
    if (!prevTabs || !nextTabs || prevTabs.length !== nextTabs.length) {
      return false
    }
    for (let index = 0; index < nextTabs.length; index += 1) {
      const prevTab = prevTabs[index] as Record<string, unknown>
      const nextTab = nextTabs[index] as Record<string, unknown>
      if (prevTab === nextTab) {
        continue
      }
      for (const key of new Set([...Object.keys(prevTab), ...Object.keys(nextTab)])) {
        if (
          !TERMINAL_TAB_PRESENTATION_KEYS.has(key) &&
          !ignoredKeys.has(key) &&
          prevTab[key] !== nextTab[key]
        ) {
          return false
        }
      }
    }
  }
  return true
}
