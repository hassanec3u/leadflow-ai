'use client'

/**
 * Last-resort boundary for errors thrown in the root layout itself.
 * It must render its own <html>/<body> because the root layout has failed.
 * Intentionally dependency-free — anything it imports could be the thing that
 * is broken.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body
        style={{
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center',
          padding: '1rem',
          margin: 0,
        }}
      >
        <div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ color: '#6b7280', marginTop: '0.5rem', fontSize: '0.875rem' }}>
            Please refresh the page.
          </p>
          {error.digest ? (
            <p style={{ color: '#9ca3af', marginTop: '0.75rem', fontSize: '0.75rem' }}>
              Reference: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  )
}
