import { registerWindowHandlers } from './window'
import { registerDialogHandlers } from './dialog'
import { registerNotificationHandlers } from './notification'
import { registerSessionHandlers } from './session'
import { registerConfigHandlers } from './config'
import { registerMediaHandlers } from './media'
import { registerClaudeGuiHandlers } from './claudeGui'
import { registerOpencodeHandlers } from './opencode'
import { registerUpdaterHandlers } from './updater'

export function registerAllHandlers(): void {
  registerWindowHandlers()
  registerDialogHandlers()
  registerNotificationHandlers()
  registerSessionHandlers()
  registerConfigHandlers()
  registerMediaHandlers()
  registerClaudeGuiHandlers()
  registerOpencodeHandlers()
  registerUpdaterHandlers()
}
