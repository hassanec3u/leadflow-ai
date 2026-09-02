import { redirect } from 'next/navigation'

import { getCurrentUser } from '@/lib/auth/session'

/**
 * Root route. Phase 0 has no marketing page, so it simply routes people to the
 * right place: the app if signed in, the login screen otherwise.
 */
export default async function RootPage() {
  const user = await getCurrentUser()
  redirect(user ? '/dashboard' : '/login')
}
