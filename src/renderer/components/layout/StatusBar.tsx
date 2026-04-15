import { useEffect, useState } from 'react'
import { Clock, FolderOpen, GitBranch, Timer } from 'lucide-react'
import { useSessionsStore } from '@/stores/sessions'
import { usePanesStore } from '@/stores/panes'

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

function formatClock(timestamp: number): string {
  const d = new Date(timestamp)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatUptime(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const secs = s % 60
  if (days > 0) return `${days}d ${pad(hours)}:${pad(mins)}:${pad(secs)}`
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}`
}

export function StatusBar(): JSX.Element {
  const activePaneId = usePanesStore((s) => s.activePaneId)
  const activeSessionId = usePanesStore((s) => s.paneActiveSession[activePaneId] ?? null)
  const sessions = useSessionsStore((s) => s.sessions)
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null

  const [now, setNow] = useState(Date.now())
  const [branch, setBranch] = useState<string | null>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // Fetch git branch whenever cwd changes
  useEffect(() => {
    const cwd = activeSession?.cwd
    if (!cwd) {
      setBranch(null)
      return
    }
    let canceled = false
    window.api.shell.getBranch(cwd)
      .then((b) => { if (!canceled) setBranch(b) })
      .catch(() => { if (!canceled) setBranch(null) })
    return () => { canceled = true }
  }, [activeSession?.cwd])

  const cwd = activeSession?.cwd ?? ''
  const uptime = activeSession?.createdAt ? now - activeSession.createdAt : 0

  return (
    <div className="flex h-[30px] w-full shrink-0 items-center justify-between gap-5 bg-[var(--color-bg-secondary)] px-4 text-[13px] text-[var(--color-text-tertiary)]">
      <div className="flex min-w-0 items-center gap-4">
        {cwd && (
          <div className="flex min-w-0 items-center gap-1.5" title={cwd}>
            <FolderOpen size={13} className="shrink-0" />
            <span className="truncate">{cwd}</span>
          </div>
        )}
        {branch && (
          <div className="flex items-center gap-1.5">
            <GitBranch size={13} className="shrink-0" />
            <span>{branch}</span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {activeSession && (
          <div className="flex items-center gap-1.5" title="Session uptime">
            <Timer size={13} />
            <span>{formatUptime(uptime)}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Clock size={13} />
          <span>{formatClock(now)}</span>
        </div>
      </div>
    </div>
  )
}
