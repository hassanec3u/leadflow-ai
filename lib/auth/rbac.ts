/**
 * Role definitions and capability matrix.
 *
 * Pure and dependency-free so it can be unit tested and also imported by
 * client components for presentation (showing/hiding nav items). Presentation
 * use is a convenience only — enforcement always happens server-side via
 * `requireRole()` / `requireCapability()` in lib/auth/session.ts.
 *
 * Source of truth for the matrix: docs/product-spec.md §11.
 */

export const ROLES = ['ADMIN', 'MANAGER', 'SALES_REP'] as const
export type Role = (typeof ROLES)[number]

export type Capability =
  | 'leads:view:all'
  | 'leads:edit:all'
  | 'automation:manage'
  | 'campaigns:manage'
  | 'integrations:manage'
  | 'users:manage'
  | 'billing:manage'
  | 'analytics:view:org'

/**
 * Capability grants per role. A capability absent from a role's list is denied.
 *
 * Note SALES_REP holds no `:all` capability: a rep's access to leads is scoped
 * to records they own, which is an ownership filter applied at query time in
 * Phase 1 — not a capability that can be granted here.
 */
const CAPABILITIES_BY_ROLE: Record<Role, readonly Capability[]> = {
  ADMIN: [
    'leads:view:all',
    'leads:edit:all',
    'automation:manage',
    'campaigns:manage',
    'integrations:manage',
    'users:manage',
    'billing:manage',
    'analytics:view:org',
  ],
  MANAGER: [
    'leads:view:all',
    'leads:edit:all',
    'automation:manage',
    'campaigns:manage',
    'analytics:view:org',
  ],
  SALES_REP: [],
}

export function hasCapability(role: Role, capability: Capability): boolean {
  return CAPABILITIES_BY_ROLE[role].includes(capability)
}

export function capabilitiesFor(role: Role): readonly Capability[] {
  return CAPABILITIES_BY_ROLE[role]
}

/** Human-readable role label for UI display. */
export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Administrator',
  MANAGER: 'Manager',
  SALES_REP: 'Sales Rep',
}
