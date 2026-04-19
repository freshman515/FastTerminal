import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { IPC, type ExternalIdeId, type TerminalShellId } from '@shared/types'
import { getAvailableIdes, openProjectInIde } from '../services/IdeLauncher'
import { openAdminTerminal } from '../services/TerminalLauncher'

const execFileAsync = promisify(execFile)

export function registerDialogHandlers(): void {
  ipcMain.handle(IPC.SHELL_OPEN_PATH, (_event, path: string) => {
    shell.openPath(path)
  })

  ipcMain.handle(IPC.SHELL_OPEN_EXTERNAL, (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) return
    void shell.openExternal(url)
  })

  ipcMain.handle('shell:get-branch', async (_event, cwd: string): Promise<string | null> => {
    if (!cwd) return null
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        windowsHide: true,
        timeout: 2000,
      })
      const branch = stdout.trim()
      return branch.length > 0 ? branch : null
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.SHELL_OPEN_IN_IDE, (_event, ide: ExternalIdeId, path: string) => {
    return openProjectInIde(ide, path)
  })

  ipcMain.handle(IPC.SHELL_LIST_IDES, () => {
    return getAvailableIdes()
  })

  ipcMain.handle(IPC.SHELL_OPEN_ADMIN_TERMINAL, (_event, path: string, shellId: TerminalShellId) => {
    return openAdminTerminal(path, shellId)
  })

  ipcMain.handle(IPC.DIALOG_SELECT_FOLDER, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Project Folder',
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  })
}
