'use client'

import { useEffect } from 'react'

import { Button } from '@/components/ui/button'

/**
 * Route-level error boundary.
 *
 * Only a generic message is rendered. `error.message` is deliberately NOT
 * displayed: in production Next.js replaces it with a digest, but in
 * development it can carry connection strings, SQL, or provider detail, and a
 * component that shows it in dev is one config change away from showing it in
 * production.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Server-side logging already happened where the error was thrown; this
    // records the client-side occurrence with the digest for correlation.
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Client error boundary triggered',
        digest: error.digest ?? null,
        timestamp: new Date().toISOString(),
      }),
    )
  }, [error.digest])

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <div>
        <h1 className="text-foreground text-xl font-semibold">Something went wrong</h1>
        <p className="text-muted-foreground mt-2 max-w-md text-sm">
          We hit an unexpected problem. Trying again often clears it.
        </p>
        {error.digest ? (
          <p className="text-muted-foreground mt-3 font-mono text-xs">Reference: {error.digest}</p>
        ) : null}
      </div>
      <Button onClick={reset}>Try again</Button>
    </div>
  )
}
