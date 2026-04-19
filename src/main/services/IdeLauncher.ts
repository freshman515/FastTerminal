import { exec, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  EXTERNAL_IDE_OPTIONS,
  type ExternalIdeId,
  type ExternalIdeOption,
  type OpenIdeResult,
} from '@shared/types'

const execAsync = promisify(exec)

interface IdeLauncherConfig {
  commands: string[]
  windowsPaths: string[]
  wrapperExeRelative?: string[]
  windowsSearches?: WindowsSearch[]
}

interface WindowsSearch {
  root: string
  depth: number
  match: (dirName: string) => boolean
  relativeExe: string[]
}

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const PROGRAMFILES = process.env.PROGRAMFILES ?? ''
const PROGRAMFILES_X86 = process.env['PROGRAMFILES(X86)'] ?? ''

function programFilesPath(...segments: string[]): string {
  return PROGRAMFILES ? path.join(PROGRAMFILES, ...segments) : ''
}

function localAppDataPath(...segments: string[]): string {
  return LOCALAPPDATA ? path.join(LOCALAPPDATA, ...segments) : ''
}

function jetBrainsToolboxSearch(productDir: string, executable: string): WindowsSearch {
  return {
    root: localAppDataPath('JetBrains', 'Toolbox', 'apps', productDir),
    depth: 2,
    match: () => true,
    relativeExe: ['bin', executable],
  }
}

function jetBrainsProgramFilesSearch(productName: RegExp, executable: string): WindowsSearch {
  return {
    root: PROGRAMFILES,
    depth: 1,
    match: (dirName) => productName.test(dirName),
    relativeExe: ['bin', executable],
  }
}

function jetBrainsProgramFilesX86Search(productName: RegExp, executable: string): WindowsSearch {
  return {
    root: PROGRAMFILES_X86,
    depth: 1,
    match: (dirName) => productName.test(dirName),
    relativeExe: ['bin', executable],
  }
}

const IDE_LAUNCHERS: Record<ExternalIdeId, IdeLauncherConfig> = {
  vscode: {
    commands: ['code', 'code.cmd', 'code.exe'],
    windowsPaths: [
      localAppDataPath('Programs', 'Microsoft VS Code', 'Code.exe'),
    ],
    wrapperExeRelative: ['..', 'Code.exe'],
  },
  'vscode-insiders': {
    commands: ['code-insiders', 'code-insiders.cmd', 'code-insiders.exe'],
    windowsPaths: [
      localAppDataPath('Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
    ],
    wrapperExeRelative: ['..', 'Code - Insiders.exe'],
  },
  cursor: {
    commands: ['cursor', 'cursor.cmd', 'cursor.exe'],
    windowsPaths: [
      localAppDataPath('Programs', 'Cursor', 'Cursor.exe'),
    ],
  },
  trae: {
    commands: ['trae', 'trae.cmd', 'trae.exe'],
    windowsPaths: [
      localAppDataPath('Programs', 'Trae', 'Trae.exe'),
    ],
    wrapperExeRelative: ['..', 'Trae.exe'],
  },
  windsurf: {
    commands: ['windsurf', 'windsurf.cmd', 'windsurf.exe'],
    windowsPaths: [
      localAppDataPath('Programs', 'Windsurf', 'Windsurf.exe'),
    ],
    wrapperExeRelative: ['..', 'Windsurf.exe'],
  },
  'visual-studio': {
    commands: ['devenv', 'devenv.exe'],
    windowsPaths: [
      programFilesPath('Microsoft Visual Studio', '2022', 'Community', 'Common7', 'IDE', 'devenv.exe'),
      programFilesPath('Microsoft Visual Studio', '2022', 'Professional', 'Common7', 'IDE', 'devenv.exe'),
      programFilesPath('Microsoft Visual Studio', '2022', 'Enterprise', 'Common7', 'IDE', 'devenv.exe'),
      programFilesPath('Microsoft Visual Studio', '2019', 'Community', 'Common7', 'IDE', 'devenv.exe'),
      programFilesPath('Microsoft Visual Studio', '2019', 'Professional', 'Common7', 'IDE', 'devenv.exe'),
      programFilesPath('Microsoft Visual Studio', '2019', 'Enterprise', 'Common7', 'IDE', 'devenv.exe'),
    ],
  },
  rider: {
    commands: ['rider', 'rider64.exe', 'rider.exe'],
    windowsPaths: [
      localAppDataPath('Programs', 'Rider', 'bin', 'rider64.exe'),
      localAppDataPath('Programs', 'Rider', 'bin', 'rider.exe'),
    ],
    windowsSearches: [
      jetBrainsToolboxSearch('Rider', 'rider64.exe'),
      jetBrainsProgramFilesSearch(/^JetBrains Rider\b/i, 'rider64.exe'),
      jetBrainsProgramFilesX86Search(/^JetBrains Rider\b/i, 'rider64.exe'),
    ],
  },
  webstorm: {
    commands: ['webstorm', 'webstorm64.exe', 'webstorm.exe'],
    windowsPaths: [],
    windowsSearches: [
      jetBrainsToolboxSearch('WebStorm', 'webstorm64.exe'),
      jetBrainsProgramFilesSearch(/^(JetBrains )?WebStorm\b/i, 'webstorm64.exe'),
      jetBrainsProgramFilesX86Search(/^(JetBrains )?WebStorm\b/i, 'webstorm64.exe'),
    ],
  },
  intellij: {
    commands: ['idea', 'idea64.exe', 'idea.exe'],
    windowsPaths: [],
    windowsSearches: [
      jetBrainsToolboxSearch('IDEA-U', 'idea64.exe'),
      jetBrainsToolboxSearch('IDEA-C', 'idea64.exe'),
      jetBrainsProgramFilesSearch(/^(JetBrains )?IntelliJ IDEA\b/i, 'idea64.exe'),
      jetBrainsProgramFilesX86Search(/^(JetBrains )?IntelliJ IDEA\b/i, 'idea64.exe'),
    ],
  },
  pycharm: {
    commands: ['pycharm', 'pycharm64.exe', 'pycharm.exe'],
    windowsPaths: [],
    windowsSearches: [
      jetBrainsToolboxSearch('PyCharm-P', 'pycharm64.exe'),
      jetBrainsToolboxSearch('PyCharm-C', 'pycharm64.exe'),
      jetBrainsProgramFilesSearch(/^(JetBrains )?PyCharm\b/i, 'pycharm64.exe'),
      jetBrainsProgramFilesX86Search(/^(JetBrains )?PyCharm\b/i, 'pycharm64.exe'),
    ],
  },
  goland: {
    commands: ['goland', 'goland64.exe', 'goland.exe'],
    windowsPaths: [],
    windowsSearches: [
      jetBrainsToolboxSearch('GoLand', 'goland64.exe'),
      jetBrainsProgramFilesSearch(/^(JetBrains )?GoLand\b/i, 'goland64.exe'),
      jetBrainsProgramFilesX86Search(/^(JetBrains )?GoLand\b/i, 'goland64.exe'),
    ],
  },
  clion: {
    commands: ['clion', 'clion64.exe', 'clion.exe'],
    windowsPaths: [],
    windowsSearches: [
      jetBrainsToolboxSearch('CLion', 'clion64.exe'),
      jetBrainsProgramFilesSearch(/^(JetBrains )?CLion\b/i, 'clion64.exe'),
      jetBrainsProgramFilesX86Search(/^(JetBrains )?CLion\b/i, 'clion64.exe'),
    ],
  },
  phpstorm: {
    commands: ['phpstorm', 'phpstorm64.exe', 'phpstorm.exe'],
    windowsPaths: [],
    windowsSearches: [
      jetBrainsToolboxSearch('PhpStorm', 'phpstorm64.exe'),
      jetBrainsProgramFilesSearch(/^(JetBrains )?PhpStorm\b/i, 'phpstorm64.exe'),
      jetBrainsProgramFilesX86Search(/^(JetBrains )?PhpStorm\b/i, 'phpstorm64.exe'),
    ],
  },
  rubymine: {
    commands: ['rubymine', 'rubymine64.exe', 'rubymine.exe'],
    windowsPaths: [],
    windowsSearches: [
      jetBrainsToolboxSearch('RubyMine', 'rubymine64.exe'),
      jetBrainsProgramFilesSearch(/^(JetBrains )?RubyMine\b/i, 'rubymine64.exe'),
      jetBrainsProgramFilesX86Search(/^(JetBrains )?RubyMine\b/i, 'rubymine64.exe'),
    ],
  },
  'android-studio': {
    commands: ['studio', 'studio64.exe', 'studio.exe'],
    windowsPaths: [
      programFilesPath('Android', 'Android Studio', 'bin', 'studio64.exe'),
      programFilesPath('Android', 'Android Studio', 'bin', 'studio.exe'),
    ],
    windowsSearches: [
      jetBrainsToolboxSearch('AndroidStudio', 'studio64.exe'),
    ],
  },
}

function getPathext(): string[] {
  if (process.platform !== 'win32') return ['']
  const raw = process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM'
  return raw
    .split(';')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function resolveFromPath(command: string): string | null {
  if (!command) return null

  if (path.isAbsolute(command)) {
    return existsSync(command) ? command : null
  }

  const pathEntries = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)

  const ext = path.extname(command)
  const suffixes = ext ? [''] : getPathext()

  for (const dir of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, ext ? command : `${command}${suffix}`)
      if (existsSync(candidate)) return candidate
    }
  }

  return null
}

function findExecutableInSearch(
  root: string,
  depth: number,
  match: (dirName: string) => boolean,
  relativeExe: string[],
): string | null {
  if (!root || !existsSync(root)) return null

  const visit = (currentPath: string, remainingDepth: number): string | null => {
    let entries: string[]
    try {
      entries = readdirSync(currentPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return null
    }

    for (const dirName of entries) {
      const fullPath = path.join(currentPath, dirName)
      if (match(dirName)) {
        const candidate = path.join(fullPath, ...relativeExe)
        if (existsSync(candidate)) return candidate
      }
      if (remainingDepth > 0) {
        const nested = visit(fullPath, remainingDepth - 1)
        if (nested) return nested
      }
    }

    return null
  }

  return visit(root, depth)
}

function preferGuiExecutable(launcher: IdeLauncherConfig, resolved: string): string {
  if (!/\.(cmd|bat)$/i.test(resolved) || !launcher.wrapperExeRelative) {
    return resolved
  }

  const candidate = path.resolve(path.dirname(resolved), ...launcher.wrapperExeRelative)
  return existsSync(candidate) ? candidate : resolved
}

function resolveIdeExecutable(ide: ExternalIdeId): string | null {
  const launcher = IDE_LAUNCHERS[ide]
  const candidates = [...launcher.windowsPaths, ...launcher.commands]
  for (const candidate of candidates) {
    const resolved = resolveFromPath(candidate)
    if (resolved) return preferGuiExecutable(launcher, resolved)
  }
  for (const search of launcher.windowsSearches ?? []) {
    const resolved = findExecutableInSearch(search.root, search.depth, search.match, search.relativeExe)
    if (resolved) return resolved
  }
  return null
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''")
}

async function launchDetached(executable: string, targetPath: string): Promise<void> {
  if (process.platform === 'win32') {
    const escapedExe = escapePowerShellSingleQuoted(executable)
    const escapedPath = escapePowerShellSingleQuoted(targetPath)
    await execAsync(
      `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "Start-Process -FilePath '${escapedExe}' -ArgumentList '${escapedPath}'"`,
      { windowsHide: true },
    )
    return
  }

  await new Promise<void>((resolve, reject) => {
    const isCmdLauncher = /\.(cmd|bat)$/i.test(executable)
    const child = isCmdLauncher
      ? spawn('sh', ['-lc', `${quoteForCmd(executable)} ${quoteForCmd(targetPath)}`], {
          detached: true,
          stdio: 'ignore',
        })
      : spawn(executable, [targetPath], {
          detached: true,
          stdio: 'ignore',
        })

    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export async function openProjectInIde(ide: ExternalIdeId, targetPath: string): Promise<OpenIdeResult> {
  if (!targetPath || !existsSync(targetPath)) {
    return { ok: false, error: '目标项目路径不存在。' }
  }

  const executable = resolveIdeExecutable(ide)
  if (!executable) {
    return { ok: false, error: '未找到该 IDE，请确认已安装或已加入 PATH。' }
  }

  try {
    await launchDetached(executable, targetPath)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '启动 IDE 失败。',
    }
  }
}

export function getAvailableIdes(): ExternalIdeOption[] {
  return EXTERNAL_IDE_OPTIONS.filter((option) => resolveIdeExecutable(option.id) !== null)
}
