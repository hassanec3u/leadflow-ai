import { PageHeader } from '@/components/layout/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { QualificationSettingsForm } from '@/components/settings/qualification-settings-form'
import { requireUser } from '@/lib/auth/session'
import { hasCapability } from '@/lib/auth/rbac'
import { getQualificationConfig } from '@/lib/services/qualification-config'

export const metadata = { title: 'Qualification — LeadFlow AI' }

/**
 * Settings → Qualification.
 *
 * Everyone signed in may READ the configuration — a rep looking at a score of
 * 38 deserves to know what it was judged against. Only an ADMIN may change it,
 * which the SERVICE enforces (`requireCapability('integrations:manage')`);
 * `canEdit` below only decides whether the controls are offered.
 */
export default async function QualificationSettingsPage() {
  const user = await requireUser()
  const config = await getQualificationConfig()
  const canEdit = hasCapability(user.role, 'integrations:manage')

  return (
    <>
      <PageHeader
        title="Qualification"
        description="How the AI decides which leads are worth pursuing"
      />
      <div className="max-w-3xl p-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your qualification profile</CardTitle>
            <CardDescription>
              LeadFlow&apos;s scoring rules, output format and security rules are fixed and not
              editable. What you set here is who you sell to, and where the bar sits.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <QualificationSettingsForm initial={config} canEdit={canEdit} />
          </CardContent>
        </Card>
      </div>
    </>
  )
}
