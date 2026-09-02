import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// React Testing Library does not auto-clean under Vitest's globals; without
// this, DOM from one test leaks into the next and queries match stale nodes.
afterEach(() => {
  cleanup()
})
