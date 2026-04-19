import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { TerminalShellId } from '@shared/types'
import { detectShell } from './ShellDetector'

const execFileAsync = promisify(execFile)

export interface LaunchResult {
  ok: boolean
  error?: string
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''")
}

function powerShellString(value: string): string {
  return `'${escapePowerShellSingleQuoted(value)}'`
}

function powerShellArray(values: string[]): string {
  if (values.length === 0) return '@()'
  return `@(${values.map(powerShellString).join(', ')})`
}

function quoteCmdValue(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function buildAdminShellArgs(targetPath: string, shell: ReturnType<typeof detectShell>): string[] {
  if (shell.syntax === 'powershell') {
    return [
      ...shell.args,
      '-NoExit',
      '-Command',
      `Set-Location -LiteralPath ${powerShellString(targetPath)}`,
    ]
  }

  if (shell.syntax === 'cmd') {
    return ['/K', `cd /d ${quoteCmdValue(targetPath)}`]
  }

  return shell.args
}

export async function openAdminTerminal(
  targetPath: string,
  preferredShell: TerminalShellId,
): Promise<LaunchResult> {
  if (process.platform !== 'win32') {
    return { ok: false, error: '管理员终端仅支持 Windows。' }
  }

  if (!targetPath || !existsSync(targetPath)) {
    return { ok: false, error: '目标目录不存在。' }
  }

  const shell = detectShell(preferredShell)
  const args = buildAdminShellArgs(targetPath, shell)
  const script = [
    '$ErrorActionPreference = "Stop"',
    `Start-Process -FilePath ${powerShellString(shell.shell)} -ArgumentList ${powerShellArray(args)} -WorkingDirectory ${powerShellString(targetPath)} -Verb RunAs`,
  ].join('; ')

  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], { windowsHide: true })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '启动管理员终端失败。',
    }
  }
}
