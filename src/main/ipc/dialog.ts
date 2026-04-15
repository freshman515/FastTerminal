import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { IPC, type ExternalIdeId } from '@shared/types'

const execFileAsync = promisify(execFile)

export function registerDialogHandlers(): void {
  ipcMain.handle(IPC.SHELL_OPEN_PATH, (_event, path: string) => {
    shell.openPath(path)
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

  ipcMain.handle(IPC.SHELL_OPEN_IN_IDE, (_event, _ide: ExternalIdeId, _path: string) => {
    return false
  })

  ipcMain.handle(IPC.SHELL_LIST_IDES, () => {
    return []
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
