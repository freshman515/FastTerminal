import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { SessionType, TerminalShellId, TerminalShellOption } from '@shared/types'

const isWindows = process.platform === 'win32'
type WindowsShellId = Exclude<TerminalShellId, 'auto'>
type ShellSyntax = 'cmd' | 'powershell' | 'posix'

export interface ShellInfo {
  id: TerminalShellId | 'unix'
  requestedId: TerminalShellId
  label: string
  shell: string
  args: string[]
  syntax: ShellSyntax
  warning?: string
}

interface WindowsShellMeta {
  label: string
  description: string
  installHint?: string
}

interface ResolvedWindowsShell {
  id: WindowsShellId
  label: string
  shell: string
  args: string[]
  syntax: Extract<ShellSyntax, 'cmd' | 'powershell'>
}

const WINDOWS_SHELL_META: Record<WindowsShellId, WindowsShellMeta> = {
  pwsh: {
    label: 'PowerShell 7',
    description: '使用 pwsh.exe，适合现代 PowerShell 工作流。',
    installHint: '安装 PowerShell 7：winget install Microsoft.PowerShell',
  },
  powershell: {
    label: 'Windows PowerShell',
    description: '使用系统自带的 powershell.exe。',
  },
  cmd: {
    label: 'Command Prompt',
    description: '使用传统 cmd.exe。',
  },
}

export function detectShell(preferredShell: TerminalShellId = 'auto'): ShellInfo {
  if (isWindows) {
    return detectWindowsShell(preferredShell)
  }
  return detectUnixShell()
}

export function listTerminalShellOptions(): TerminalShellOption[] {
  if (!isWindows) {
    const shell = detectUnixShell()
    return [
      {
        id: 'auto',
        label: 'Auto',
        description: 'Use the shell configured by the operating system.',
        available: true,
        path: shell.shell,
      },
    ]
  }

  const autoShell = resolveAutoWindowsShell()
  return [
    {
      id: 'auto',
      label: '自动检测',
      description: autoShell
        ? `当前会使用 ${autoShell.label}。`
        : '按系统默认可用终端启动。',
      available: true,
      path: autoShell?.shell,
    },
    ...(['pwsh', 'powershell', 'cmd'] as const).map((id): TerminalShellOption => {
      const resolved = resolveWindowsShell(id)
      const meta = WINDOWS_SHELL_META[id]
      return {
        id,
        label: meta.label,
        description: meta.description,
        available: Boolean(resolved),
        path: resolved?.shell,
        installHint: meta.installHint,
      }
    }),
  ]
}

function detectUnixShell(): ShellInfo {
  const userShell = process.env['SHELL']
  if (userShell) {
    return {
      id: 'unix',
      requestedId: 'auto',
      label: userShell,
      shell: userShell,
      args: ['-l'],
      syntax: 'posix',
    }
  }

  const fallbacks = ['/bin/zsh', '/bin/bash', '/bin/sh']
  for (const s of fallbacks) {
    if (existsSync(s)) {
      return {
        id: 'unix',
        requestedId: 'auto',
        label: s,
        shell: s,
        args: ['-l'],
        syntax: 'posix',
      }
    }
  }

  return {
    id: 'unix',
    requestedId: 'auto',
    label: '/bin/sh',
    shell: '/bin/sh',
    args: [],
    syntax: 'posix',
  }
}

function detectWindowsShell(preferredShell: TerminalShellId): ShellInfo {
  if (preferredShell === 'auto') {
    const autoShell = resolveAutoWindowsShell()
    if (autoShell) return toShellInfo(autoShell, 'auto')
    return {
      id: 'cmd',
      requestedId: 'auto',
      label: WINDOWS_SHELL_META.cmd.label,
      shell: 'cmd.exe',
      args: [],
      syntax: 'cmd',
      warning: '未检测到可用终端，正在尝试使用 cmd.exe。',
    }
  }

  const requestedShell = resolveWindowsShell(preferredShell)
  if (requestedShell) return toShellInfo(requestedShell, preferredShell)

  const fallbackShell = resolveAutoWindowsShell()
  if (fallbackShell) {
    const meta = WINDOWS_SHELL_META[preferredShell]
    const installHint = meta.installHint ? ` ${meta.installHint}` : ''
    return {
      ...toShellInfo(fallbackShell, preferredShell),
      warning: `未检测到 ${meta.label}，已回退到 ${fallbackShell.label}。${installHint}`,
    }
  }

  const meta = WINDOWS_SHELL_META[preferredShell]
  const installHint = meta.installHint ? ` ${meta.installHint}` : ''
  return {
    id: 'cmd',
    requestedId: preferredShell,
    label: WINDOWS_SHELL_META.cmd.label,
    shell: 'cmd.exe',
    args: [],
    syntax: 'cmd',
    warning: `未检测到 ${meta.label}，正在尝试使用 cmd.exe。${installHint}`,
  }
}

function toShellInfo(shell: ResolvedWindowsShell, requestedId: TerminalShellId): ShellInfo {
  return {
    id: shell.id,
    requestedId,
    label: shell.label,
    shell: shell.shell,
    args: shell.args,
    syntax: shell.syntax,
  }
}

function resolveAutoWindowsShell(): ResolvedWindowsShell | null {
  for (const shellId of ['pwsh', 'powershell', 'cmd'] as const) {
    const shell = resolveWindowsShell(shellId)
    if (shell) return shell
  }
  return null
}

function resolveWindowsShell(shellId: WindowsShellId): ResolvedWindowsShell | null {
  if (shellId === 'pwsh') {
    const path = firstExistingPath([
      join(process.env.ProgramW6432 ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'PowerShell', '7', 'pwsh.exe'),
      findExecutableOnPath('pwsh'),
    ])
    return path
      ? {
          id: 'pwsh',
          label: WINDOWS_SHELL_META.pwsh.label,
          shell: path,
          args: ['-NoLogo'],
          syntax: 'powershell',
        }
      : null
  }

  if (shellId === 'powershell') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const path = firstExistingPath([
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      findExecutableOnPath('powershell'),
    ])
    return path
      ? {
          id: 'powershell',
          label: WINDOWS_SHELL_META.powershell.label,
          shell: path,
          args: ['-NoLogo'],
          syntax: 'powershell',
        }
      : null
  }

  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const comspec = process.env.COMSPEC
  const path = firstExistingPath([
    comspec,
    join(systemRoot, 'System32', 'cmd.exe'),
    findExecutableOnPath('cmd'),
  ])
  return path
    ? {
        id: 'cmd',
        label: WINDOWS_SHELL_META.cmd.label,
        shell: path,
        args: [],
        syntax: 'cmd',
      }
    : null
}

function firstExistingPath(paths: Array<string | null | undefined>): string | null {
  for (const path of paths) {
    if (path && existsSync(path)) return path
  }
  return null
}

function findExecutableOnPath(command: string): string | null {
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  if (!pathValue) return null

  const extensions = command.includes('.')
    ? ['']
    : (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((ext) => ext.trim())
        .filter(Boolean)

  for (const rawDir of pathValue.split(delimiter)) {
    const dir = rawDir.trim().replace(/^"|"$/g, '')
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }

  return null
}

export function buildAgentCommand(
  type: SessionType,
  _sessionId?: string,
  resume?: boolean,
  resumeUUID?: string,
): { command: string; args: string[] } | null {
  if (type === 'terminal' || type === 'claude-gui') {
    return null
  }

  if (type === 'claude-code' || type === 'claude-code-yolo') {
    const baseArgs = type === 'claude-code-yolo' ? ['--dangerously-skip-permissions'] : []
    if (resume && resumeUUID) {
      return { command: 'claude', args: [...baseArgs, '--resume', resumeUUID] }
    }
    return { command: 'claude', args: baseArgs }
  }

  if (type === 'codex') {
    return { command: 'codex', args: [] }
  }

  if (type === 'codex-yolo') {
    return { command: 'codex', args: ['--dangerously-bypass-approvals-and-sandbox'] }
  }

  if (type === 'opencode') {
    return { command: 'opencode', args: [] }
  }

  return null
}
