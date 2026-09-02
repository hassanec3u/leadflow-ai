import { Sparkles } from 'lucide-react'

/** Centred, chrome-free layout for the unauthenticated auth screens. */
export default function AuthLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="bg-background flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="mb-8 flex items-center gap-3">
        <span className="bg-primary flex size-10 items-center justify-center rounded-xl">
          <Sparkles className="text-primary-foreground size-5" aria-hidden />
        </span>
        <div>
          <p className="text-foreground text-lg font-semibold leading-tight">LeadFlow AI</p>
          <p className="text-muted-foreground text-xs">AI Lead Automation</p>
        </div>
      </div>
      {children}
    </div>
  )
}
