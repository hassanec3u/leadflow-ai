import 'server-only'

import { randomBytes } from 'node:crypto'

import { requireCapability } from '@/lib/auth/session'
import { hashFormCaptureSecret } from '@/lib/auth/form-capture-lookup'
import { withTenant } from '@/lib/db/tenant'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { logger } from '@/lib/logger'

/**
 * Issuing and rotating an organization's Website Form capture secret
 * (Phase 2E-1).
 *
 * Only the SHA-256 hash is ever persisted. The plaintext is returned exactly
 * once — in the return value of the call that generated it — and is never
 * logged, never stored, and never recoverable afterwards. Losing it means
 * rotating, which is the correct behaviour for a credential.
 *
 * Authorisation uses the EXISTING matrix: `integrations:manage`, which
 * lib/auth/rbac.ts already grants to ADMIN only (MANAGER and SALES_REP do not
 * hold it). No new capability and no RBAC change was needed — this is an
 * integration credential, which is exactly what that capability covers.
 *
 * Tenancy comes from the authenticated session, never from a parameter: the
 * caller cannot ask for another organization's secret, and every write still
 * runs through `withTenant()` under the unchanged
 * `organizations_tenant_isolation` policy.
 */

/**
 * 32 bytes = 256 bits of CSPRNG output, base64url-encoded (43 chars). The
 * prefix makes the credential greppable in a customer's own config and
 * recognisable in a leak scan; it carries no secret material itself.
 */
const SECRET_BYTES = 32
const SECRET_PREFIX = 'lfwf_'

function generateSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`
}

export type FormCaptureSecretResult = {
  /** Plaintext, returned ONCE. Never persisted, never logged. */
  secret: string
}

/**
 * Write a freshly generated secret onto the caller's own organization and
 * return the plaintext.
 *
 * `expectExisting` distinguishes the two operations rather than duplicating
 * the write: issuing must not silently break a live form, and rotating must
 * not require one to already exist to be useful.
 */
async function setFormCaptureSecret(expectExisting: boolean): Promise<FormCaptureSecretResult> {
  // ADMIN-only, enforced server-side. Returns the session user — the
  // organization comes from there, never from an argument.
  const user = await requireCapability('integrations:manage')

  const secret = generateSecret()
  const hash = hashFormCaptureSecret(secret)

  await withTenant(user.organizationId, async (tx) => {
    const organization = await tx.organization.findFirst({
      where: { id: user.organizationId, deletedAt: null },
      select: { id: true, formCaptureSecretHash: true },
    })
    if (!organization) throw new NotFoundError('Organization not found.')

    if (!expectExisting && organization.formCaptureSecretHash !== null) {
      // Refusing here is the point: an accidental second "issue" would
      // invalidate the secret a live Website Form is already using. Rotating
      // is the explicit, deliberate way to replace it.
      throw new ConflictError('A form capture secret already exists. Rotate it instead.')
    }

    // A single UPDATE overwrites the old hash, so the previous secret stops
    // resolving the moment this transaction commits — there is no window in
    // which both are valid.
    await tx.organization.updateMany({
      where: { id: user.organizationId },
      data: { formCaptureSecretHash: hash },
    })
  })

  // Deliberately logs the EVENT, never the secret or its hash.
  logger.info('Website form capture secret written', {
    orgId: user.organizationId,
    userId: user.id,
    operation: expectExisting ? 'rotate' : 'issue',
  })

  return { secret }
}

/**
 * Issue a first capture secret. Fails with a ConflictError if one already
 * exists, so an accidental re-issue cannot take a working form offline.
 */
export async function issueFormCaptureSecret(): Promise<FormCaptureSecretResult> {
  return setFormCaptureSecret(false)
}

/**
 * Replace the capture secret. The previous one is invalid immediately on
 * commit — rotation is a revocation, not a grace period.
 */
export async function rotateFormCaptureSecret(): Promise<FormCaptureSecretResult> {
  return setFormCaptureSecret(true)
}

/**
 * Whether the caller's organization currently has a secret. Deliberately a
 * boolean: the hash itself is never returned to anyone, for any reason.
 */
export async function hasFormCaptureSecret(): Promise<boolean> {
  const user = await requireCapability('integrations:manage')

  return withTenant(user.organizationId, async (tx) => {
    const organization = await tx.organization.findFirst({
      where: { id: user.organizationId, deletedAt: null },
      select: { formCaptureSecretHash: true },
    })
    return Boolean(organization?.formCaptureSecretHash)
  })
}
