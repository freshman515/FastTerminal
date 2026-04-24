import * as pty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import { homedir } from 'node:os'
import headlessPkg from '@xterm/headless'
import serializePkg from '@xterm/addon-serialize'
import { BrowserWindow } from 'electron'
import { IPC } from '@shared/types'
import type { SessionCreateOptions, SessionReplayPayload } from '@shared/types'
import { detectShell, buildAgentCommand } from './ShellDetector'
import { isClaudeCodeType } from '@shared/types'
import { createFastTerminalMcpConfig } from './FastTerminalMcpService'

const isWindows = process.platform === 'win32'
const HeadlessTerminal = (headlessPkg as { Terminal: new (options?: Record<string, unknown>) => import('@xterm/headless').Terminal }).Terminal
const SerializeAddon = (serializePkg as { SerializeAddon: new () => import('@xterm/addon-serialize').SerializeAddon }).SerializeAddon

interface TerminalMirror {
  terminal: import('@xterm/headless').Terminal
  serializeAddon: import('@xterm/addon-serialize').SerializeAddon
  pendingWrite: Promise<void>
}

interface ManagedPty {
  pty: IPty
  cwd: string
  type: SessionCreateOptions['type']
  sessionId: string | undefined
  replayBuffer: string
  mirror: TerminalMirror
  dataSeq: number
  resumeId: string | null
}

// Agent CLIs (especially Codex/Claude) emit a lot of ANSI/TUI repaint traffic.
// When a session tab is unmounted during project/worktree switches we rebuild
// the terminal from this replay buffer. 64 KiB is too small and causes the
// replay to start mid-stream, which drops earlier content and can leave the
// restored screen visually blank/truncated.
const MAX_REPLAY_CHARS = 4 * 1024 * 1024

function createTerminalMirror(cols: number, rows: number): TerminalMirror {
  const terminal = new HeadlessTerminal({
    cols,
    rows,
    scrollback: 10_000,
    allowProposedApi: true,
  })
  const serializeAddon = new SerializeAddon()
  terminal.loadAddon(serializeAddon as unknown as { activate(terminal: unknown): void; dispose(): void })
  return {
    terminal,
    serializeAddon,
    pendingWrite: Promise.resolve(),
  }
}

function queueMirrorWrite(mirror: TerminalMirror, data: string): void {
  mirror.pendingWrite = mirror.pendingWrite
    .catch(() => undefined)
    .then(
      () =>
        new Promise<void>((resolve) => {
          mirror.terminal.write(data, resolve)
        }),
    )
}

function disposeTerminalMirror(mirror: TerminalMirror): void {
  try {
    mirror.serializeAddon.dispose()
  } catch {
    // ignore
  }
  try {
    mirror.terminal.dispose()
  } catch {
    // ignore
  }
}

// Strip ANSI escape sequences for text matching
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][0-2AB]|\x1b[>=<]|\x1b\[[\?!]?[0-9;]*[hlm]/g, '')
}

function getResumePattern(type: SessionCreateOptions['type']): RegExp | null {
  if (type === 'claude-code' || type === 'claude-code-yolo') {
    return /claude\s+--resume\s+([0-9a-f-]{36})/i
  }
  return null
}

function quoteShellArg(value: string, syntax: 'cmd' | 'powershell' | 'posix'): string {
  if (syntax === 'posix') {
    if (value.length === 0) return "''"
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
    return `'${value.replace(/'/g, "'\\''")}'`
  }
  if (!/[\s"'&()^|<>;]/.test(value)) return value
  if (syntax === 'powershell') return `'${value.replace(/'/g, "''")}'`
  return `"${value.replace(/"/g, '""')}"`
}

function buildPosixShellCommand(command: string, args: string[]): string {
  return [command, ...args].map((part) => quoteShellArg(part, 'posix')).join(' ')
}

function getPowerShellCwdTrackingScript(): string {
  return [
    '$global:__FastTerminalProfilePaths = @($PROFILE.AllUsersAllHosts, $PROFILE.AllUsersCurrentHost, $PROFILE.CurrentUserAllHosts, $PROFILE.CurrentUserCurrentHost)',
    'foreach ($global:__FastTerminalProfilePath in $global:__FastTerminalProfilePaths) {',
    '  try {',
    '    if ($global:__FastTerminalProfilePath -and (Test-Path -LiteralPath $global:__FastTerminalProfilePath)) {',
    '      . $global:__FastTerminalProfilePath',
    '    }',
    '  } catch {',
    '    Write-Warning $_',
    '  }',
    '}',
    'Remove-Variable __FastTerminalProfilePath -Scope Global -ErrorAction SilentlyContinue',
    'Remove-Variable __FastTerminalProfilePaths -Scope Global -ErrorAction SilentlyContinue',
    '$global:__FastTerminalLastCwd = $null',
    'function global:__FastTerminalEmitCwd {',
    '  try {',
    '    $location = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation',
    '    if (-not $location) { return }',
    '    $path = $location.ProviderPath',
    '    if ($global:__FastTerminalLastCwd -eq $path) { return }',
    '    $global:__FastTerminalLastCwd = $path',
    '    $uri = [System.Uri]::new($path).AbsoluteUri',
    '    [Console]::Write("$([char]27)]7;$uri$([char]7)")',
    '  } catch {}',
    '}',
    'try { Unregister-Event -SourceIdentifier "FastTerminal.Cwd" -ErrorAction SilentlyContinue } catch {}',
    '$global:__FastTerminalCwdTimer = [System.Timers.Timer]::new(250)',
    '$global:__FastTerminalCwdTimer.AutoReset = $true',
    '$global:__FastTerminalCwdEvent = Register-ObjectEvent -InputObject $global:__FastTerminalCwdTimer -EventName Elapsed -SourceIdentifier "FastTerminal.Cwd" -Action {',
    '  try {',
    '    $location = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation',
    '    if (-not $location) { return }',
    '    $path = $location.ProviderPath',
    '    if ($global:__FastTerminalLastCwd -eq $path) { return }',
    '    $global:__FastTerminalLastCwd = $path',
    '    $uri = [System.Uri]::new($path).AbsoluteUri',
    '    [Console]::Write("$([char]27)]7;$uri$([char]7)")',
    '  } catch {}',
    '}',
    '$global:__FastTerminalCwdTimer.Start()',
    '__FastTerminalEmitCwd',
  ].join('; ')
}

interface McpBridgeEnv {
  port: number
  token: string
}

export type DataObserver = (ptyId: string) => void

export class PtyManager {
  private readonly ptys = new Map<string, ManagedPty>()
  private idCounter = 0

  /** Populated by OrchestratorService.init() so PTYs spawned afterwards see the
   *  MCP bridge port + token in their env. Sessions spawned before init() will
   *  not have access to the bridge — orchestrator should be initialized first. */
  private mcpEnv: McpBridgeEnv | null = null

  /** Observers notified once per visible PTY data chunk. Used by the
   *  orchestrator service to track per-PTY idle time for /wait_idle. */
  private readonly dataObservers = new Set<DataObserver>()

  setMcpEnv(env: McpBridgeEnv | null): void {
    this.mcpEnv = env
  }

  /** Subscribe to PTY data emissions. Returns an unsubscribe function. */
  addDataObserver(observer: DataObserver): () => void {
    this.dataObservers.add(observer)
    return () => { this.dataObservers.delete(observer) }
  }

  /** Reverse lookup: renderer Session.id → ptyId. Used by the MCP bridge to
   *  let agents address sessions by the same id shown in the UI. */
  findPtyIdBySessionId(sessionId: string): string | null {
    for (const [ptyId, managed] of this.ptys) {
      if (managed.sessionId === sessionId) return ptyId
    }
    return null
  }

  private notifyDataObservers(ptyId: string): void {
    for (const observer of this.dataObservers) {
      try {
        observer(ptyId)
      } catch {
        // Observer errors must never break the data path.
      }
    }
  }

  create(options: SessionCreateOptions): { id: string; cwd: string } {
    const id = `pty-${++this.idCounter}-${Date.now()}`
    const shell = detectShell(options.terminalShell ?? 'auto')

    let shellPath = shell.shell
    let shellArgs: string[] = [...shell.args]

    // For agent sessions, wrap the agent command
    const agentCmd = buildAgentCommand(options.type, options.sessionId, options.resume, options.resumeUUID)
    if (!agentCmd && isWindows && options.type === 'terminal' && shell.syntax === 'powershell') {
      shellArgs = [...shellArgs, '-NoProfile', '-NoExit', '-Command', getPowerShellCwdTrackingScript()]
    }

    // For Claude Code sessions, append --mcp-config pointing to a per-session
    // JSON that carries the live orchestrator port/token. This is what gives
    // the agent zero-config access to ft_* tools from inside FastTerminal.
    if (agentCmd && isClaudeCodeType(options.type) && options.sessionId && this.mcpEnv) {
      const mcpConfigPath = createFastTerminalMcpConfig({
        port: this.mcpEnv.port,
        token: this.mcpEnv.token,
        sessionId: options.sessionId,
      })
      if (mcpConfigPath) {
        agentCmd.args.push('--mcp-config', mcpConfigPath)
      }
    }
    // Codex spawns MCP servers with a sealed env — only entries from
    // config.toml are visible. SESSION_ID is per-PTY, so we can't store it
    // there; override it with Codex's `-c` flag.
    //
    // Pass the value WITHOUT TOML quotes: session ids like `mo1gtu87-rsjk8r`
    // aren't valid TOML (bare identifier with dash), so codex falls back to
    // a literal string. Quoting with `"..."` would be TOML-correct but the
    // shell layer (pwsh / bash) then escapes the `"` itself, and PowerShell
    // does not honor `\"` — the arg splits mid-value and codex treats the
    // remainder as a PROMPT positional argument.
    if (
      agentCmd
      && (options.type === 'codex' || options.type === 'codex-yolo')
      && options.sessionId
      && this.mcpEnv
    ) {
      agentCmd.args = [
        '-c',
        `mcp_servers.fastterminal.env.FASTTERMINAL_SESSION_ID=${options.sessionId}`,
        ...agentCmd.args,
      ]
    }

    if (agentCmd && !isWindows) {
      const fullCmd = buildPosixShellCommand(agentCmd.command, agentCmd.args)
      // Preserve the original shell args (for example `-l`) and append the
      // command payload to execute.
      shellArgs = [...shellArgs, '-c', fullCmd]
    }

    const cols = options.cols ?? 120
    const rows = options.rows ?? 30
    const cwd = options.cwd && options.cwd.length > 0 ? options.cwd : homedir()

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // Inject session ID so hook scripts can identify this exact session
      ...(options.sessionId ? { FASTTERMINAL_SESSION_ID: options.sessionId } : {}),
      // FastTerminal MCP bridge — agents can use these to talk back to us.
      ...(this.mcpEnv ? {
        FASTTERMINAL_IDE_PORT: String(this.mcpEnv.port),
        FASTTERMINAL_MCP_TOKEN: this.mcpEnv.token,
      } : {}),
      ...(options.env ?? {}),
    }

    const ptyProcess = pty.spawn(shellPath, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      useConpty: isWindows,
    })

    const managed: ManagedPty = {
      pty: ptyProcess,
      cwd,
      type: options.type,
      sessionId: options.sessionId,
      replayBuffer: '',
      mirror: createTerminalMirror(cols, rows),
      dataSeq: 0,
      resumeId: null,
    }

    this.ptys.set(id, managed)

    // For agent sessions on Windows, suppress output until the agent CLI actually starts.
    // The shell prompt + command echo arrive before the agent banner.
    // Keep suppressed bytes buffered: some TUIs draw the whole first screen once and
    // then stay idle until SIGWINCH. If we only flip a boolean on timeout, the
    // renderer remains blank until the user manually resizes the window.
    const isAgentSession = options.type !== 'terminal'
    const shouldSuppressAgentBootstrap = isWindows && isAgentSession
    let agentStarted = !shouldSuppressAgentBootstrap
    let pendingAgentOutput = ''
    let agentForwardTimer: NodeJS.Timeout | null = null

    // Agent banner keywords (case-insensitive checked)
    const AGENT_KEYWORDS = ['Claude Code', 'Codex', 'opencode', 'OpenCode', 'open-code']

    const sendToWindows = (payload: { ptyId: string; data: string; seq: number }): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.SESSION_DATA, payload)
        }
      }
    }

    const broadcastResumeId = (resumeId: string): void => {
      if (!managed.sessionId) return
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('session:resume-uuids', { [managed.sessionId]: resumeId })
        }
      }
    }

    const captureResumeId = (): void => {
      const pattern = getResumePattern(managed.type)
      if (!pattern) return
      const clean = stripAnsi(managed.replayBuffer)
      const match = clean.match(pattern)
      const nextResumeId = match?.[1] ?? null
      if (!nextResumeId || nextResumeId === managed.resumeId) return
      managed.resumeId = nextResumeId
      broadcastResumeId(nextResumeId)
    }

    const emitVisibleData = (data: string): void => {
      queueMirrorWrite(managed.mirror, data)
      managed.dataSeq += 1
      sendToWindows({ ptyId: id, data, seq: managed.dataSeq })
      this.notifyDataObservers(id)
    }

    if (shell.warning) {
      setTimeout(() => {
        if (!this.ptys.has(id)) return
        emitVisibleData(`\x1b[33m[FastTerminal] ${shell.warning}\x1b[0m\r\n`)
      }, 50)
    }

    const startForwardingAgentOutput = (): void => {
      if (agentStarted) return
      agentStarted = true
      if (pendingAgentOutput) {
        emitVisibleData(pendingAgentOutput)
        pendingAgentOutput = ''
      }
    }

    if (shouldSuppressAgentBootstrap) {
      agentForwardTimer = setTimeout(startForwardingAgentOutput, 3000)
    }

    // Forward data to all windows
    ptyProcess.onData((data) => {
      // Append to replay buffer (always, for graceful shutdown capture)
      managed.replayBuffer += data
      if (managed.replayBuffer.length > MAX_REPLAY_CHARS) {
        managed.replayBuffer = managed.replayBuffer.slice(-MAX_REPLAY_CHARS)
      }
      captureResumeId()

      // For agent sessions, suppress shell prompt/command, only show agent output
      if (!agentStarted) {
        const raw = managed.replayBuffer
        const clean = stripAnsi(raw)
        pendingAgentOutput += data
        const detected = AGENT_KEYWORDS.some((kw) => clean.includes(kw) || raw.includes(kw))
        if (detected) {
          startForwardingAgentOutput()
        }
        return
      }

      emitVisibleData(data)

      // Permission & idle notifications are handled by HookServer (Claude Code hooks)
    })

    ptyProcess.onExit(({ exitCode }) => {
      if (agentForwardTimer) {
        clearTimeout(agentForwardTimer)
        agentForwardTimer = null
      }
      startForwardingAgentOutput()

      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.SESSION_EXIT, { ptyId: id, exitCode, resumeUUID: managed.resumeId })
        }
      }
      if (this.ptys.has(id)) {
        disposeTerminalMirror(managed.mirror)
        this.ptys.delete(id)
      }
    })

    // For agent sessions on Windows, send the command after shell is ready.
    // Exit the wrapper shell after the agent exits so PTY exit events fire.
    if (agentCmd && isWindows) {
      setTimeout(() => {
        const parts = [agentCmd.command, ...agentCmd.args].map((part) => quoteShellArg(part, shell.syntax))
        const suffix = options.type !== 'terminal'
          ? (shell.syntax === 'cmd' ? ' & exit' : ' ; exit')
          : ''
        ptyProcess.write(parts.join(' ') + suffix + '\r')
      }, 500)
    }

    return { id, cwd }
  }

  write(id: string, data: string): void {
    const managed = this.ptys.get(id)
    if (!managed) return
    managed.pty.write(data)
  }

  /** Find a claude-code session by CWD path */
  findClaudeSessionByCwd(cwd: string): string | null {
    const norm = cwd.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
    for (const [, m] of this.ptys) {
      if (!m.sessionId) continue
      if (m.type !== 'claude-code' && m.type !== 'claude-code-yolo') continue
      const mCwd = m.cwd.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
      if (norm === mCwd || norm.startsWith(mCwd + '/')) return m.sessionId
    }
    return null
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      const managed = this.ptys.get(id)
      managed?.pty.resize(cols, rows)
      managed?.mirror.terminal.resize(cols, rows)
    } catch {
      // Ignore resize errors (process may have exited)
    }
  }

  kill(id: string): void {
    const managed = this.ptys.get(id)
    if (managed) {
      managed.pty.kill()
      disposeTerminalMirror(managed.mirror)
      this.ptys.delete(id)
    }

  }

  getPid(id: string): number | undefined {
    return this.ptys.get(id)?.pty.pid
  }

  isAlive(id: string): boolean {
    return this.ptys.has(id)
  }

  async getReplay(id: string): Promise<SessionReplayPayload> {
    const managed = this.ptys.get(id)
    if (!managed) return { data: '', seq: 0 }

    const targetSeq = managed.dataSeq
    const targetPendingWrite = managed.mirror.pendingWrite

    try {
      await targetPendingWrite.catch(() => undefined)
      const data = managed.mirror.serializeAddon.serialize()
      if (data) {
        return { data, seq: targetSeq }
      }
    } catch {
      // Fall back to raw replay buffer below.
    }

    return {
      data: managed.replayBuffer,
      seq: targetSeq,
    }
  }

  /**
   * Gracefully shutdown all Claude Code sessions by sending Ctrl+C twice,
   * then capture the resume id from the output.
   * Returns a map of sessionId → resumeUUID.
   */
  async gracefulShutdownClaudeSessions(): Promise<Map<string, string>> {
    const results = new Map<string, string>()
    const resumablePtys = Array.from(this.ptys.entries()).filter(
      ([, m]) =>
        (m.type === 'claude-code' || m.type === 'claude-code-yolo')
        && m.sessionId,
    )

    if (resumablePtys.length === 0) return results

    const promises = resumablePtys.map(
      ([, managed]) =>
        new Promise<void>((resolve) => {
          const ptyProcess = managed.pty
          let captureBuffer = ''
          const resumePattern = /claude\s+--resume\s+([0-9a-f-]{36})/i

          if (managed.resumeId) {
            results.set(managed.sessionId!, managed.resumeId)
          }

          // Listen for resume id in output
          const onData = ptyProcess.onData((data) => {
            captureBuffer += data
            const clean = stripAnsi(captureBuffer)
            const match = clean.match(resumePattern)
            if (match) {
              managed.resumeId = match[1]
              results.set(managed.sessionId!, match[1])
            }
          })

          // Send Ctrl+C twice with a small gap
          try {
            ptyProcess.write('\x03')
          } catch { /* ignore */ }

          setTimeout(() => {
            try {
              ptyProcess.write('\x03')
            } catch { /* ignore */ }
          }, 300)

          // Wait for output, then clean up
          setTimeout(() => {
            onData.dispose()
            // Check buffer one last time
            const clean = stripAnsi(captureBuffer)
            const match = clean.match(resumePattern)
            if (match && !results.has(managed.sessionId!)) {
              managed.resumeId = match[1]
              results.set(managed.sessionId!, match[1])
            }
            resolve()
          }, 3000)
        }),
    )

    await Promise.all(promises)
    return results
  }

  destroyAll(): void {

    for (const [, managed] of this.ptys) {
      try {
        managed.pty.kill()
      } catch {
        // ignore
      }
      disposeTerminalMirror(managed.mirror)
    }
    this.ptys.clear()
  }
}

export const ptyManager = new PtyManager()
