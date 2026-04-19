import { Zap } from 'lucide-react'
import type { MouseEvent } from 'react'

interface EmptyStateProps {
  title: string
  description: string
  onIconClick?: (event: MouseEvent<HTMLButtonElement>) => void
}

export function EmptyState({ title, description, onIconClick }: EmptyStateProps): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 px-8 text-center">
      <button
        type="button"
        onClick={onIconClick}
        className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--color-border)]/50 bg-[linear-gradient(135deg,var(--color-bg-tertiary),color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg-tertiary)))] shadow-lg shadow-black/10 transition-colors hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-bg-tertiary)]"
      >
        <Zap size={22} className="text-[var(--color-accent)]/60" />
        <div className="absolute -inset-px rounded-2xl bg-[var(--color-accent)]/[0.03]" />
      </button>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-[var(--ui-font-md)] font-semibold text-[var(--color-text-primary)]">{title}</h3>
        <p className="max-w-[260px] text-[var(--ui-font-sm)] leading-relaxed text-[var(--color-text-tertiary)]">{description}</p>
      </div>
    </div>
  )
}
