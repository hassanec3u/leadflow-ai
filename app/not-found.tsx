import Link from 'next/link'

import { Button } from '@/components/ui/button'

export const metadata = { title: 'Page not found — LeadFlow AI' }

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <div>
        <p className="text-muted-foreground text-sm font-medium">404</p>
        <h1 className="text-foreground mt-1 text-xl font-semibold">Page not found</h1>
        <p className="text-muted-foreground mt-2 max-w-md text-sm">
          That page doesn&apos;t exist, or you don&apos;t have access to it.
        </p>
      </div>
      <Button asChild>
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  )
}
