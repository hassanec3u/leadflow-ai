import 'server-only'

import type { QualificationConfigVersion } from '@prisma/client'

import { requireCapability, requireUser } from '@/lib/auth/session'
import { withTenant, type TenantDb } from '@/lib/db/tenant'
import { isUniqueConstraintViolation } from '@/lib/db/prisma-errors'
import { ConflictError, ValidationError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import {
  DEFAULT_ICP,
  DEFAULT_QUALIFICATION_THRESHOLD,
  qualificationConfigSchema,
} from '@/lib/validation/qualification-config'

/**
 * The organization's qualification configuration — append-only.
 *
 * Saving never updates a row: it inserts the next version. A WorkflowRun then
 * points at the version it was judged against, so "why did this lead score 65
 * in March?" survives the ICP being rewritten five times. Nothing here
 * deletes.
 *
 * Tenancy comes from the session on every path; no function takes an
 * organization id, so no caller can pass one in, and Postgres RLS remains the
 * second barrier underneath.
 */

const CONFIG_UNIQUE = {
  columns: ['organizationId', 'version'],
  indexName: 'qualification_config_versions_organizationId_version_key',
} as const

export type QualificationConfigView = {
  id: string | null
  version: number
  icp: string
  instructions: string | null
  threshold: number
  updatedAtLabel: string | null
  /** False when no admin has saved yet and the defaults are in force. */
  isCustomised: boolean
}

async function findLatest(
  tx: TenantDb,
  organizationId: string,
): Promise<QualificationConfigVersion | null> {
  return tx.qualificationConfigVersion.findFirst({
    where: { organizationId },
    orderBy: { version: 'desc' },
  })
}

/** Read the current configuration, or the defaults when none has been saved. */
export async function getQualificationConfig(): Promise<QualificationConfigView> {
  const user = await requireUser()

  return withTenant(user.organizationId, async (tx) => {
    const latest = await findLatest(tx, user.organizationId)

    if (!latest) {
      return {
        id: null,
        version: 0,
        icp: DEFAULT_ICP,
        instructions: null,
        threshold: DEFAULT_QUALIFICATION_THRESHOLD,
        updatedAtLabel: null,
        isCustomised: false,
      }
    }

    return {
      id: latest.id,
      version: latest.version,
      icp: latest.icp,
      instructions: latest.instructions,
      threshold: latest.threshold,
      updatedAtLabel: latest.createdAt.toISOString(),
      isCustomised: true,
    }
  })
}

/**
 * Save a new version — ADMIN only.
 *
 * `integrations:manage` is the existing capability the RBAC matrix grants to
 * ADMIN alone (MANAGER holds `automation:manage` but not this one). Choosing
 * it rather than `automation:manage` is deliberate: the ICP changes how every
 * future lead is judged and how much the org is billed for AI, which is an
 * owner-level decision, not a day-to-day one.
 *
 * Returns the existing version unchanged when nothing actually differs, so
 * re-saving an untouched form does not litter the history with duplicates.
 */
export async function saveQualificationConfig(rawInput: unknown): Promise<QualificationConfigView> {
  const user = await requireCapability('integrations:manage')

  const parsed = qualificationConfigSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ValidationError(
      'Some of the information provided is not valid.',
      parsed.error.flatten().fieldErrors,
    )
  }
  const input = parsed.data

  const created = await withTenant(user.organizationId, async (tx) => {
    const latest = await findLatest(tx, user.organizationId)

    const unchanged =
      latest !== null &&
      latest.icp === input.icp &&
      latest.instructions === input.instructions &&
      latest.threshold === input.threshold
    if (unchanged) return latest

    try {
      return await tx.qualificationConfigVersion.create({
        data: {
          organizationId: user.organizationId,
          version: (latest?.version ?? 0) + 1,
          icp: input.icp,
          instructions: input.instructions,
          threshold: input.threshold,
          createdById: user.id,
        },
      })
    } catch (error) {
      // Two admins saved at once. The unique (organizationId, version) index
      // is what serialises them — the loser must re-read rather than silently
      // overwrite a version number with different content.
      if (isUniqueConstraintViolation(error, CONFIG_UNIQUE)) {
        throw new ConflictError(
          'The qualification settings were changed by someone else. Reload and try again.',
        )
      }
      throw error
    }
  })

  // The event, never the content: an ICP is customer strategy.
  logger.info('Qualification config saved', {
    orgId: user.organizationId,
    userId: user.id,
    version: created.version,
    threshold: created.threshold,
  })

  return {
    id: created.id,
    version: created.version,
    icp: created.icp,
    instructions: created.instructions,
    threshold: created.threshold,
    updatedAtLabel: created.createdAt.toISOString(),
    isCustomised: true,
  }
}
