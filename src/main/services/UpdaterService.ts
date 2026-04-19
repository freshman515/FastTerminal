import { app, BrowserWindow } from 'electron'
import electronUpdater, { type UpdateInfo, type ProgressInfo } from 'electron-updater'

const { autoUpdater } = electronUpdater
import { IPC, type UpdaterEvent } from '@shared/types'

/**
 * Wraps electron-updater with a small IPC surface so the renderer can:
 *  - show a "new version available" prompt when one is found
 *  - trigger the download and track progress
 *  - request "quit and install" after the download completes
 *
 * Wire-up: call `initUpdaterService()` once the first window is ready. The
 * service auto-checks on startup (skipped in dev) and exposes manual checks.
 */
export class UpdaterService {
  private initialized = false
  private lastInfo: UpdateInfo | null = null
  private startupCheckStartedAt = 0
  private startupMissingMetadataHandled = false
  private lastErrorBroadcast: { message: string; at: number } | null = null

  init(): void {
    if (this.initialized) return
    this.initialized = true

    // Control flow manually — don't auto-download until user approves.
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => {
      this.broadcast({ type: 'checking' })
    })

    autoUpdater.on('update-available', (info) => {
      this.lastInfo = info
      this.broadcast({
        type: 'available',
        version: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        releaseDate: info.releaseDate,
      })
    })

    autoUpdater.on('update-not-available', (info) => {
      this.broadcast({ type: 'not-available', currentVersion: app.getVersion(), latestVersion: info.version })
    })

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.broadcast({
        type: 'progress',
        percent: Math.round(progress.percent ?? 0),
        bytesPerSecond: progress.bytesPerSecond ?? 0,
        transferred: progress.transferred ?? 0,
        total: progress.total ?? 0,
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      this.lastInfo = info
      this.broadcast({ type: 'downloaded', version: info.version })
    })

    autoUpdater.on('error', (err) => {
      this.handleError(err)
    })
  }

  /** Trigger a remote check. Safe to call multiple times. */
  async checkNow(options: { silentMissingMetadata?: boolean } = {}): Promise<void> {
    // `electron-updater` refuses to run in a non-packaged app; short-circuit
    // with a synthetic "not-available" so the dev UI stays quiet.
    if (!app.isPackaged) {
      this.broadcast({ type: 'not-available', currentVersion: app.getVersion(), latestVersion: app.getVersion(), dev: true })
      return
    }
    if (options.silentMissingMetadata) {
      this.startupCheckStartedAt = Date.now()
      this.startupMissingMetadataHandled = false
    } else {
      this.startupCheckStartedAt = 0
      this.startupMissingMetadataHandled = false
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.handleError(err)
    }
  }

  async download(): Promise<void> {
    if (!app.isPackaged) return
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      this.handleError(err)
    }
  }

  quitAndInstall(): void {
    if (!app.isPackaged) return
    // `isSilent=true, isForceRunAfter=true`: run installer silently (no NSIS
    // click-through) and auto-start the new version once it finishes.
    autoUpdater.quitAndInstall(true, true)
  }

  private broadcast(event: UpdaterEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.UPDATER_EVENT, event)
      }
    }
  }

  private handleError(err: unknown): void {
    const normalized = normalizeUpdaterError(err)
    if (normalized.kind === 'missing-release-metadata' && this.shouldSilenceMissingMetadata()) {
      if (!this.startupMissingMetadataHandled) {
        this.startupMissingMetadataHandled = true
        console.warn('[updater] release metadata latest.yml is missing; startup auto-check skipped.')
        this.broadcast({
          type: 'not-available',
          currentVersion: app.getVersion(),
          latestVersion: app.getVersion(),
        })
      }
      return
    }

    this.broadcastError(normalized.message)
  }

  private shouldSilenceMissingMetadata(): boolean {
    if (this.startupCheckStartedAt <= 0) return false
    return Date.now() - this.startupCheckStartedAt < 15_000
  }

  private broadcastError(message: string): void {
    const now = Date.now()
    if (this.lastErrorBroadcast && this.lastErrorBroadcast.message === message && now - this.lastErrorBroadcast.at < 1000) {
      return
    }

    this.lastErrorBroadcast = { message, at: now }
    this.broadcast({ type: 'error', error: message })
  }
}

function normalizeReleaseNotes(raw: UpdateInfo['releaseNotes']): string | null {
  if (!raw) return null
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw.map((item) => (typeof item === 'string' ? item : item?.note ?? '')).filter(Boolean).join('\n\n')
  }
  return null
}

function normalizeUpdaterError(err: unknown): { kind: 'missing-release-metadata' | 'generic'; message: string } {
  const message = err instanceof Error ? err.message : String(err)

  if (isMissingReleaseMetadataError(message)) {
    return {
      kind: 'missing-release-metadata',
      message: 'GitHub Release 缺少 latest.yml 更新清单，自动更新暂不可用。请确认发布时同时上传 latest.yml、安装包和 blockmap 文件。',
    }
  }

  return { kind: 'generic', message }
}

function isMissingReleaseMetadataError(message: string): boolean {
  return /latest\.yml/i.test(message) && (/\b404\b/.test(message) || /cannot find/i.test(message) || /not found/i.test(message))
}

export const updaterService = new UpdaterService()
