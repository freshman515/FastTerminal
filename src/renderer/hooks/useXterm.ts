import { useEffect, useRef, useState } from 'react'
import { Terminal, type IBufferLine, type ILink, type ILinkProvider } from '@xterm/xterm'
import { addTimelineEvent } from '@/components/rightpanel/SessionTimeline'
import { trackSessionInput, trackSessionOutput } from '@/components/rightpanel/agentRuntime'

// ─── Global terminal registry for preview snapshots ───
const terminalRegistry = new Map<string, Terminal>()

export function getTerminalPreviewText(sessionId: string, lineCount = 16): string[] {
  const terminal = terminalRegistry.get(sessionId)
  if (!terminal) return []
  const buf = terminal.buffer.active
  const result: string[] = []
  const end = buf.baseY + buf.cursorY + 1
  const start = Math.max(0, end - lineCount)
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i)
    result.push(line ? line.translateToString() : '')
  }
  return result
}

export function getTerminalBufferText(sessionId: string, lineCount = 120): string {
  return getTerminalPreviewText(sessionId, lineCount).join('\n')
}

const OSC7_CWD_PATTERN = /\x1b\]7;([^\x07\x1b]+)(?:\x07|\x1b\\)/g

function resolveAbsolutePath(p: string, cwd: string): string {
  if (/^[A-Za-z]:[\\/]/.test(p)) return p
  if (p.startsWith('/') || p.startsWith('\\')) return p
  if (p.startsWith('~/') || p.startsWith('~\\')) return p
  if (!cwd) return p
  const sep = cwd.includes('\\') ? '\\' : '/'
  const cleaned = p.replace(/^\.[\\/]/, '')
  const normalized = sep === '\\' ? cleaned.replace(/\//g, '\\') : cleaned.replace(/\\/g, '/')
  const base = cwd.endsWith(sep) ? cwd : cwd + sep
  return base + normalized
}

function quoteDroppedPath(p: string): string {
  if (/[\s"]/.test(p)) return `"${p.replace(/"/g, '\\"')}"`
  return p
}

function decodeFileCwdUri(uri: string): string | null {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'file:') return null

    let pathname = decodeURIComponent(url.pathname)
    if (window.api.platform === 'win32') {
      if (url.hostname && url.hostname !== 'localhost') {
        return `\\\\${url.hostname}${pathname.replace(/\//g, '\\')}`
      }
      if (/^\/[A-Za-z]:/.test(pathname)) {
        pathname = pathname.slice(1)
      }
      return pathname.replace(/\//g, '\\')
    }

    return pathname
  } catch {
    return null
  }
}

function extractLatestCwdFromOsc7(data: string, pending: string): { cwd: string | null; pending: string } {
  const combined = pending + data
  let cwd: string | null = null
  OSC7_CWD_PATTERN.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = OSC7_CWD_PATTERN.exec(combined)) !== null) {
    cwd = decodeFileCwdUri(match[1]) ?? cwd
  }

  const lastStart = combined.lastIndexOf('\x1b]7;')
  if (lastStart === -1) return { cwd, pending: '' }

  const belEnd = combined.indexOf('\x07', lastStart)
  const stEnd = combined.indexOf('\x1b\\', lastStart)
  const hasTerminator = belEnd !== -1 || stEnd !== -1
  if (hasTerminator) return { cwd, pending: '' }

  return { cwd, pending: combined.slice(lastStart, lastStart + 2048) }
}
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { Session, SessionDataEvent } from '@shared/types'
import { isClaudeCodeType } from '@shared/types'
import { useSessionsStore } from '@/stores/sessions'
import { useProjectsStore } from '@/stores/projects'
import { useUIStore } from '@/stores/ui'
import { usePanesStore } from '@/stores/panes'
import { useWorktreesStore } from '@/stores/worktrees'
import { getXtermTheme, defaultDarkTheme } from '@/lib/ghosttyTheme'

export function useXterm(
  session: Session,
  isActive: boolean,
): {
  containerRef: React.RefObject<HTMLDivElement | null>
  searchAddonRef: React.RefObject<SearchAddon | null>
  terminalRef: React.RefObject<Terminal | null>
  pasteFromClipboardRef: React.RefObject<(() => Promise<void>) | null>
} {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const pasteFromClipboardRef = useRef<(() => Promise<void>) | null>(null)
  const sessionRef = useRef(session)
  sessionRef.current = session

  // FastTerminal: no project management — cwd is always resolvable
  // (PtyManager falls back to os.homedir() when cwd is empty).
  const [cwdReady] = useState(true)

  // Create terminal + PTY once cwd is resolvable
  useEffect(() => {
    if (!cwdReady) return
    const container = containerRef.current
    if (!container) return

    const currentSession = sessionRef.current
    const hasExistingPty = currentSession.ptyId && currentSession.status === 'running'

    // Resolve cwd: prefer project/worktree if present (legacy paths), else
    // fall back to empty — PtyManager will use os.homedir().
    let cwd: string | undefined
    if (!hasExistingPty) {
      const project = useProjectsStore
        .getState()
        .projects.find((p) => p.id === currentSession.projectId)
      const worktreeStore = useWorktreesStore.getState()
      const worktree = currentSession.worktreeId
        ? worktreeStore.worktrees.find((w) => w.id === currentSession.worktreeId)
        : worktreeStore.getMainWorktree(currentSession.projectId)
      // Final fallback: a session.cwd hint set by the MCP bridge (Meta-Agent
      // creating a session for a path that isn't a tracked project/worktree).
      cwd = worktree?.path ?? project?.path ?? currentSession.cwd ?? ''
    }
    const sessionId = currentSession.id
    const sessionType = currentSession.type
    const shouldResume = currentSession.initialized && isClaudeCodeType(currentSession.type)
    const resumeUUID = currentSession.resumeUUID ?? undefined
    const { settings } = useUIStore.getState()
    let ptyId: string | null = null
    let destroyed = false

    const xtermTheme = getXtermTheme(settings.terminalTheme) ?? defaultDarkTheme
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: settings.terminalFontSize,
      fontFamily: settings.terminalFontFamily,
      fontWeight: 'normal',
      fontWeightBold: '500',
      theme: xtermTheme,
      scrollback: 10000,
      allowProposedApi: true,
      rescaleOverlappingGlyphs: true,
    })

    const fitAddon = new FitAddon()
    const unicode11Addon = new Unicode11Addon()
    const searchAddon = new SearchAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(unicode11Addon)
    terminal.loadAddon(searchAddon)
    terminal.unicode.activeVersion = '11'
    searchAddonRef.current = searchAddon
    terminal.open(container)
    terminalRegistry.set(sessionId, terminal)

    // URL + file-path link provider — Ctrl/Cmd+Click to open (Windows Terminal style)
    const linkProvider: ILinkProvider = {
      provideLinks(y, callback) {
        const line = terminal.buffer.active.getLine(y - 1)
        if (!line) { callback(undefined); return }
        const text = line.translateToString(true)
        const links: ILink[] = []
        const urlRanges: Array<[number, number]> = []

        // URLs
        const urlRe = /https?:\/\/[^\s<>()"'`\\]+/g
        let m: RegExpExecArray | null
        while ((m = urlRe.exec(text)) !== null) {
          const stripped = m[0].replace(/[.,;:!?)\]}>'"`]+$/, '')
          if (stripped.length === 0) continue
          const start = m.index
          const end = start + stripped.length
          urlRanges.push([start, end])
          links.push({
            range: { start: { x: start + 1, y }, end: { x: end, y } },
            text: stripped,
            activate: (event) => {
              if (event.ctrlKey || event.metaKey) {
                void window.api.shell.openExternal(stripped)
              }
            },
          })
        }

        // File paths with optional :line[:col] suffix
        // Requires either an anchor prefix (drive / ./ / ~/ / absolute slash)
        // OR at least two segments with a slash in between, to avoid false positives.
        const pathRe = /((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\/)[\w.@+\-]+(?:[\\/][\w.@+\-]+)*|[\w.@+\-]+(?:[\\/][\w.@+\-]+)+)(?::\d+(?::\d+)?)?/g
        while ((m = pathRe.exec(text)) !== null) {
          const raw = m[0]
          const start = m.index
          const end = start + raw.length
          // Skip overlap with any URL match
          if (urlRanges.some(([us, ue]) => start < ue && end > us)) continue
          const stripped = raw.replace(/[.,;:!?)\]}>'"`]+$/, '')
          if (stripped.length === 0) continue
          const trueEnd = start + stripped.length
          const parsed = stripped.match(/^(.+?)(?::(\d+)(?::(\d+))?)?$/)
          if (!parsed) continue
          const rawPath = parsed[1]
          const lineNo = parsed[2] ? Number.parseInt(parsed[2], 10) : undefined
          const colNo = parsed[3] ? Number.parseInt(parsed[3], 10) : undefined
          const hoverText = lineNo !== undefined
            ? `${rawPath}:${lineNo}${colNo !== undefined ? `:${colNo}` : ''}`
            : rawPath
          links.push({
            range: { start: { x: start + 1, y }, end: { x: trueEnd, y } },
            text: hoverText,
            activate: (event) => {
              if (event.ctrlKey || event.metaKey) {
                const cwd = sessionRef.current.cwd ?? ''
                const absPath = resolveAbsolutePath(rawPath, cwd)
                void window.api.shell.openPath(absPath)
              }
            },
          })
        }

        callback(links.length > 0 ? links : undefined)
      },
    }
    const linkProviderDisposable = terminal.registerLinkProvider(linkProvider)

    // File drop → paste quoted absolute paths into terminal
    const onDragOver = (e: DragEvent): void => {
      if (!e.dataTransfer) return
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent): void => {
      if (!e.dataTransfer) return
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return
      const paths = files
        .map((f) => ((f as File & { path?: string }).path ?? '').trim())
        .filter(Boolean)
        .map(quoteDroppedPath)
      if (paths.length === 0) return
      terminal.focus()
      terminal.paste(paths.join(' '))
    }
    container.addEventListener('dragover', onDragOver)
    container.addEventListener('drop', onDrop)

    // Ctrl/Cmd + Wheel → zoom terminal font (persists via settings store)
    // Register in capture phase + stopPropagation so we intercept before
    // xterm's own wheel listener (on .xterm-viewport) scrolls the buffer.
    const onWheelZoom = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      e.stopPropagation()
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation()
      }
      const state = useUIStore.getState()
      const current = state.settings.terminalFontSize
      const delta = e.deltaY < 0 ? 1 : -1
      const next = Math.max(8, Math.min(32, current + delta))
      if (next !== current) {
        state.updateSettings({ terminalFontSize: next })
      }
    }
    container.addEventListener('wheel', onWheelZoom, { capture: true, passive: false })

    // IME compositionend: clear textarea to prevent stale content
    const textarea = terminal.textarea
    if (textarea) {
      textarea.addEventListener('compositionend', () => {
        setTimeout(() => { textarea.value = '' }, 0)
      })
    }

    // Use DOM renderer (not WebGL) for better CJK text rendering quality

    fitAddonRef.current = fitAddon
    terminalRef.current = terminal

    // Helper: fit xterm, resize PTY, and force a repaint. Used both for the
    // initial sizing cascade and for any late container layout.
    //
    // Key subtlety: fitAddon.fit() no-ops when the computed cols/rows equal
    // the current ones, which means NO terminal.resize, NO onResize event,
    // NO SIGWINCH, and no xterm re-layout. Under that condition Claude Code
    // / Codex / Opencode can stay blank until the user manually resizes the
    // window. To guarantee forward progress we nudge the dimensions by 1
    // column and back — it costs one extra SIGWINCH but reliably forces a
    // full relayout + repaint and prompts the agent TUI to redraw.
    const syncSize = (): void => {
      if (destroyed) return
      try {
        fitAddon.fit()
        const cols = terminal.cols
        const rows = terminal.rows
        if (cols > 1 && rows > 1) {
          terminal.resize(cols - 1, rows)
          terminal.resize(cols, rows)
        }
        if (ptyId) {
          window.api.session.resize(ptyId, cols, rows)
        }
        try { terminal.refresh(0, rows - 1) } catch { /* ignore */ }
      } catch {
        // ignore
      }
    }

    // Try synchronous fit first (container is often already laid out after
    // React commit). Fall back to rAF and staggered timeouts to cover the
    // case where layout hasn't settled when the hook runs.
    syncSize()
    requestAnimationFrame(syncSize)
    const fitTimers = [
      setTimeout(syncSize, 50),
      setTimeout(syncSize, 200),
      setTimeout(syncSize, 600),
    ]

    // Check if session already has an active PTY (e.g. after React remount during reorder)
    const existingPtyId = currentSession.ptyId
    let restoreReady = !(existingPtyId && currentSession.status === 'running')
    let restoredSnapshotSeq = 0
    const pendingRestoreEvents: SessionDataEvent[] = []

    // PTY → xterm
    let firstDataSynced = false
    let pendingCwdControl = ''
    const offData = window.api.session.onData((event) => {
      if (event.ptyId && event.ptyId === ptyId) {
        trackSessionOutput(sessionId, event.data)
        const cwdUpdate = extractLatestCwdFromOsc7(event.data, pendingCwdControl)
        pendingCwdControl = cwdUpdate.pending
        if (cwdUpdate.cwd && cwdUpdate.cwd !== sessionRef.current.cwd) {
          useSessionsStore.getState().updateSession(sessionId, { cwd: cwdUpdate.cwd })
        }
        if (!restoreReady) {
          pendingRestoreEvents.push(event)
          return
        }
        terminal.write(event.data)
        // First-byte sync: agent TUIs that take a moment to boot (Claude Code,
        // Codex, Opencode) may emit their first draw long after all our timed
        // cascades fired. A single fit+refresh here closes that window.
        if (!firstDataSynced) {
          firstDataSynced = true
          fitTimers.push(setTimeout(syncSize, 50), setTimeout(syncSize, 400))
        }
      }
    })

    // PTY exit
    const offExit = window.api.session.onExit((event) => {
      if (event.ptyId && event.ptyId === ptyId) {
        ptyId = null
        terminal.write(
          `\r\n\x1b[90m[Process exited with code ${event.exitCode}]\x1b[0m\r\n`,
        )
        useSessionsStore.getState().updateStatus(sessionId, 'stopped')
        addTimelineEvent(sessionId, 'stop', `Exited with code ${event.exitCode}`)
      }
    })

    const restoreFromSnapshot = async (): Promise<void> => {
      if (!existingPtyId || currentSession.status !== 'running') return

      ptyId = existingPtyId

      try {
        const replay = await window.api.session.getReplay(existingPtyId)
        if (destroyed) return

        restoredSnapshotSeq = replay.seq
        if (replay.data) {
          await new Promise<void>((resolve) => {
            terminal.write(replay.data, resolve)
          })
        }
      } finally {
        restoreReady = true

        if (destroyed) return

        for (const pendingEvent of pendingRestoreEvents) {
          if (pendingEvent.seq > restoredSnapshotSeq) {
            terminal.write(pendingEvent.data)
          }
        }
        pendingRestoreEvents.length = 0

        // Same sizing cascade as the fresh-PTY path — critical when the
        // session is re-mounted after split / pane move / app restart,
        // otherwise Claude Code / Codex leave a blank viewport until the
        // user resizes the window.
        requestAnimationFrame(syncSize)
        fitTimers.push(
          setTimeout(syncSize, 80),
          setTimeout(syncSize, 250),
          setTimeout(syncSize, 700),
          setTimeout(syncSize, 1500),
        )
      }
    }

    if (existingPtyId && currentSession.status === 'running') {
      // Reuse existing PTY — restore a serialized terminal snapshot, then
      // append only live chunks that arrived after the snapshot sequence.
      void restoreFromSnapshot()
    } else {
      // Create new PTY using whatever dimensions xterm has settled on by now
      // (fit() was attempted synchronously above).
      window.api.session
        .create({
          cwd: cwd ?? '',
          type: sessionType,
          sessionId,
          resume: shouldResume,
          resumeUUID,
          terminalShell: settings.terminalShell,
          cols: terminal.cols || 80,
          rows: terminal.rows || 24,
        })
        .then((result) => {
          if (destroyed) {
            window.api.session.kill(result.ptyId)
            return
          }
          ptyId = result.ptyId
          useSessionsStore
            .getState()
            .updateSession(sessionId, { ptyId, status: 'running', initialized: true, cwd: result.cwd })
          addTimelineEvent(sessionId, 'start', `Session started (${sessionType})`)

          // Agent TUIs (Claude Code, Opencode, Codex) often snapshot terminal
          // dimensions once at launch. Re-fit and re-resize over a ~1s window
          // so late layout or slow CLI startup still converges to correct
          // dimensions without the user having to resize / switch tabs.
          requestAnimationFrame(syncSize)
          fitTimers.push(
            setTimeout(syncSize, 80),
            setTimeout(syncSize, 250),
            setTimeout(syncSize, 700),
            setTimeout(syncSize, 1500),
          )
        })
        .catch((error) => {
          if (destroyed) return
          const message = error instanceof Error ? error.message : String(error)
          terminal.write(`\r\n\x1b[31m[Failed to start session: ${message}]\x1b[0m\r\n`)
          useSessionsStore.getState().updateSession(sessionId, {
            ptyId: null,
            status: 'stopped',
          })
          useUIStore.getState().addToast({
            type: 'error',
            title: 'Session failed to start',
            body: `${currentSession.name}: ${message}`,
          })
          addTimelineEvent(sessionId, 'error', `Start failed: ${message}`)
        })
    }

    // Undo stack for software undo (used by non-terminal sessions).
    // Each entry is a "chunk" that was added in one action (paste = one chunk, keystroke = one char).
    let undoStack: string[] = []

    // Unified clipboard paste — used by Ctrl+V handler and the context-menu
    // "Paste" action so both paths record undo chunks and share the image /
    // text dispatch logic for Claude Code / Codex.
    const pasteFromClipboard = async (): Promise<void> => {
      if (sessionType === 'terminal') {
        try {
          const text = await navigator.clipboard.readText()
          if (!text) return
          terminal.focus()
          terminal.paste(text)
          trackSessionInput(sessionId)
          addTimelineEvent(sessionId, 'input', 'Clipboard paste')
        } catch {}
        return
      }

      // Claude Code / Codex: image → Alt+V (native), text → inject
      try {
        const items = await navigator.clipboard.read()
        const hasImage = items.some((item) => item.types.some((t) => t.startsWith('image/')))
        if (hasImage) {
          if (ptyId) {
            // Capture what the agent echoes (e.g. "[Image #1]") so Ctrl+Z can undo it
            let echoed = ''
            const offCapture = window.api.session.onData((event: SessionDataEvent) => {
              if (event.ptyId === ptyId) echoed += event.data
            })
            setTimeout(() => {
              offCapture()
              // eslint-disable-next-line no-control-regex
              const printable = echoed.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[^\x20-\x7e]/g, '')
              if (printable.length > 0) undoStack.push(printable)
            }, 400)
            window.api.session.write(ptyId, '\x1bv')
          }
          return
        }
      } catch {
        // clipboard.read() may be unavailable; fall through to text paste
      }

      try {
        const text = await navigator.clipboard.readText()
        if (!text) return
        const printable = [...text].filter((ch) => {
          const c = ch.charCodeAt(0)
          return c >= 32 && c !== 127
        }).join('')
        if (printable.length > 0) undoStack.push(printable)
        terminal.focus()
        terminal.paste(text)
        trackSessionInput(sessionId)
        addTimelineEvent(sessionId, 'input', 'Clipboard paste')
      } catch {}
    }

    pasteFromClipboardRef.current = pasteFromClipboard

    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true

      // Allow IME composition (Chinese/Japanese/Korean input)
      if (e.isComposing || e.keyCode === 229) return true

      // Let global shortcuts bubble to window for App-level handlers
      if ((e.ctrlKey && e.key === 'Tab')
        || (e.ctrlKey && e.key === 'w')
        || (e.ctrlKey && e.key === 'p')
        || (e.ctrlKey && e.key >= '1' && e.key <= '9')
        || (e.ctrlKey && e.key === 'f')
        || (e.ctrlKey && e.shiftKey && e.key === 'T')
        || e.key === 'F11') {
        return false
      }

      // Ctrl+Alt+Arrow — navigate panes directly (avoid dispatch issues)
      if (e.ctrlKey && e.altKey && e.key.startsWith('Arrow')) {
        const dir = e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right' : e.key === 'ArrowUp' ? 'up' : 'down'
        usePanesStore.getState().navigatePane(dir as 'left' | 'right' | 'up' | 'down')
        return false
      }

      // Ctrl+C: copy selection if any, otherwise send to shell
      if (e.ctrlKey && e.key === 'c') {
        const selection = terminal.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection)
          terminal.clearSelection()
          return false
        }
        return true
      }

      // Ctrl+Z: undo last input
      // - terminal (bash): send Ctrl+_ (\x1f) — readline undo
      // - claude-code / codex: pop last undo-stack entry and send that many backspaces
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'z') {
        if (ptyId) {
          if (sessionType === 'terminal') {
            window.api.session.write(ptyId, '\x1f')
          } else if (undoStack.length > 0) {
            const last = undoStack.pop()!
            // Send one \x7f per code point (handles multi-byte unicode)
            window.api.session.write(ptyId, '\x7f'.repeat([...last].length))
          }
        }
        return false
      }

      // Ctrl/Cmd+V: clipboard paste for all session types. xterm.js does NOT
      // have a built-in Ctrl+V handler — it turns Ctrl+V into the raw \x16
      // control byte, which in bash is "quoted insert", not paste. Route every
      // session type through pasteFromClipboard() so the terminal / opencode
      // branches get real text paste, and the agent branches keep their smart
      // image → Alt+V + text-inject logic. Shift+Insert / context-menu Paste
      // go through the same function to stay in sync.
      if ((e.ctrlKey || e.metaKey)
        && !e.altKey
        && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        e.stopPropagation()
        void pasteFromClipboard()
        return false
      }

      return true
    })

    // xterm → PTY
    const onDataDisposable = terminal.onData((data) => {
      if (ptyId) {
        // Track individual keystrokes for non-terminal sessions (pastes are tracked at call site)
        if (sessionType !== 'terminal' && data.length === 1) {
          const code = data.charCodeAt(0)
          if (code >= 32 && code !== 127) {
            undoStack.push(data)
          } else if (code === 127 || code === 8) {
            // Backspace — trim tail of last chunk, remove if empty
            if (undoStack.length > 0) {
              const last = undoStack[undoStack.length - 1]
              const trimmed = [...last].slice(0, -1).join('')
              if (trimmed.length > 0) {
                undoStack[undoStack.length - 1] = trimmed
              } else {
                undoStack.pop()
              }
            }
          } else if (code === 13 || code === 10) {
            undoStack = []
          }
        }
        window.api.session.write(ptyId, data)
        if (data === '\r' || data === '\n') {
          trackSessionInput(sessionId)
          addTimelineEvent(sessionId, 'input', 'User input')
        }
      }
    })

    // Resize
    const onResizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (ptyId) {
        window.api.session.resize(ptyId, cols, rows)
      }
    })

    // Container resize observer
    const resizeObserver = new ResizeObserver(() => {
      if (!destroyed) {
        try {
          fitAddon.fit()
        } catch {
          // ignore
        }
      }
    })
    resizeObserver.observe(container)

    return () => {
      destroyed = true
      for (const t of fitTimers) clearTimeout(t)
      terminalRegistry.delete(sessionId)
      terminalRef.current = null
      fitAddonRef.current = null
      searchAddonRef.current = null
      pasteFromClipboardRef.current = null
      offData()
      offExit()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      linkProviderDisposable.dispose()
      container.removeEventListener('dragover', onDragOver)
      container.removeEventListener('drop', onDrop)
      container.removeEventListener('wheel', onWheelZoom, { capture: true } as EventListenerOptions)
      resizeObserver.disconnect()
      terminal.dispose()
      // NOTE: Do NOT kill PTY here. PTY lifecycle is independent of the React component.
      // PTY is killed explicitly via session.kill() when user closes a tab.
    }
  }, [cwdReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit and focus when becoming active. Intentionally does NOT nudge cols
  // by ±1: on tab / pane switches the container size is unchanged, so forcing
  // an extra SIGWINCH only causes agent TUIs (notably Claude Code) to redraw
  // the whole screen at cols-1 then cols, which reads as a visible jitter.
  // The cold-start nudge lives in the mount-time syncSize path and is enough.
  useEffect(() => {
    if (!isActive) return
    const term = terminalRef.current
    const fit = fitAddonRef.current
    const nudge = (): void => {
      try {
        fit?.fit()
        if (!term) return
        term.refresh(0, term.rows - 1)
      } catch { /* ignore */ }
    }
    const timers = [0, 50, 200].map((delay) => setTimeout(nudge, delay))
    const focusTimer = setTimeout(() => term?.focus(), 60)
    return () => {
      for (const t of timers) clearTimeout(t)
      clearTimeout(focusTimer)
    }
  }, [isActive])

  // Live-update terminal font when settings change
  useEffect(() => {
    let prevSize = useUIStore.getState().settings.terminalFontSize
    let prevFamily = useUIStore.getState().settings.terminalFontFamily

    return useUIStore.subscribe((state) => {
      const { terminalFontSize, terminalFontFamily } = state.settings
      if (terminalFontSize === prevSize && terminalFontFamily === prevFamily) return
      prevSize = terminalFontSize
      prevFamily = terminalFontFamily

      const term = terminalRef.current
      if (!term) return
      term.options.fontSize = terminalFontSize
      term.options.fontFamily = terminalFontFamily
      try {
        fitAddonRef.current?.fit()
      } catch {
        // ignore
      }
    })
  }, [])

  // Live-update terminal theme when settings change
  useEffect(() => {
    let prevTheme = useUIStore.getState().settings.terminalTheme

    return useUIStore.subscribe((state) => {
      const { terminalTheme } = state.settings
      if (terminalTheme === prevTheme) return
      prevTheme = terminalTheme

      const term = terminalRef.current
      if (!term) return
      const newTheme = getXtermTheme(terminalTheme) ?? defaultDarkTheme
      term.options.theme = newTheme
    })
  }, [])

  return { containerRef, searchAddonRef, terminalRef, pasteFromClipboardRef }
}
