import { Plug } from 'lucide-react'

import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireCapability } from '@/lib/auth/session'
import { getIntegrationAvailability } from '@/lib/env'

export const metadata = { title: 'Integrations — LeadFlow AI' }

/**
 * Phase 0 placeholder. Connecting integrations is Phase 3-5.
 *
 * What this page DOES do today is reflect configuration reality: it reads which
 * optional credentials are present in the environment. That verifies the
 * "app starts and runs without integration credentials" requirement visibly,
 * rather than only in a test.
 */
export default async function IntegrationsPage() {
  await requireCapability('integrations:manage')

  const availability = getIntegrationAvailability()

  const integrations = [
    {
      key: 'openai',
      name: 'OpenAI',
      description: 'AI qualification, summaries and drafted follow-up email.',
      configured: availability.openai,
      phase: 'Phase 3',
    },
    {
      key: 'airtable',
      name: 'Airtable',
      description: 'One-way CRM sync of qualified leads.',
      configured: availability.airtable,
      phase: 'Phase 5',
    },
    {
      key: 'slack',
      name: 'Slack',
      description: 'Notify the owning rep or a shared channel.',
      configured: availability.slack,
      phase: 'Phase 5',
    },
    {
      key: 'email',
      name: 'Email provider',
      description: 'Send follow-up email and track opens and replies.',
      configured: availability.email,
      phase: 'Phase 4 — vendor not yet selected',
    },
    {
      key: 'enrichment',
      name: 'Enrichment provider',
      description: 'Firmographic enrichment before qualification.',
      configured: false,
      phase: 'Phase 3 — vendor not yet selected',
    },
  ] as const

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect the services that power your pipeline"
      />
      <div className="space-y-4 p-8">
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Plug className="size-4" aria-hidden />
          Connection management arrives with Phase 3-5. This page currently reflects which
          credentials the server has configured.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          {integrations.map((integration) => (
            <Card key={integration.key}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <CardTitle className="text-base">{integration.name}</CardTitle>
                  <Badge variant={integration.configured ? 'default' : 'secondary'}>
                    {integration.configured ? 'Credentials present' : 'Not configured'}
                  </Badge>
                </div>
                <CardDescription>{integration.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-xs">{integration.phase}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </>
  )
}
