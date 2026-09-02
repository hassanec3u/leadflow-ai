import Link from 'next/link'

import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ROLE_LABELS } from '@/lib/auth/rbac'
import { requireOrganization, requireUser } from '@/lib/auth/session'

export const metadata = { title: 'Settings — LeadFlow AI' }

/**
 * Phase 0: shows the current account and organization, which is genuinely
 * useful now (it makes session/tenant resolution observable). User management
 * and billing are Phase 7.
 */
export default async function SettingsPage() {
  const user = await requireUser()
  const organization = await requireOrganization()

  return (
    <>
      <PageHeader title="Settings" description="Your account and organization" />
      <div className="grid max-w-3xl gap-4 p-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Organization</CardTitle>
            <CardDescription>The workspace all of your data belongs to.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Name</span>
              <span className="font-medium">{organization.name}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Slug</span>
              <span className="font-mono text-xs">{organization.slug}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your account</CardTitle>
            <CardDescription>Team management and billing arrive in Phase 7.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Name</span>
              <span className="font-medium">{user.name ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Email</span>
              <span className="font-medium">{user.email}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Role</span>
              <Badge variant="secondary">{ROLE_LABELS[user.role]}</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Qualification</CardTitle>
            <CardDescription>
              How the AI decides which leads are worth pursuing — your ideal customer profile and
              qualification threshold.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" asChild>
              <Link href="/settings/qualification">Manage qualification settings</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
