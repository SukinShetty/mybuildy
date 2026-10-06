// useRefreshWhileOpen.ts — a window picker's list is fetched fresh when it opens
// and again every few seconds while it stays open, so a window closed in the
// meantime disappears from it. Used by every picker (robot, Guidance tab, setup).

import { useEffect, useRef } from 'react'

export const WINDOW_LIST_REFRESH_MS = 3000

export function useRefreshWhileOpen(open: boolean, refresh: () => void | Promise<void>): void {
  const latest = useRef(refresh)
  latest.current = refresh
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => { void latest.current() }, WINDOW_LIST_REFRESH_MS)
    return () => clearInterval(timer)
  }, [open])
}
