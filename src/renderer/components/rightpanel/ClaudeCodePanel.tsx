interface ClaudeCodePanelProps {
  sessionId: string
}

export function ClaudeCodePanel(_props: ClaudeCodePanelProps): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center text-[var(--color-text-tertiary)] text-xs">
      Claude GUI unavailable in FastTerminal
    </div>
  )
}
