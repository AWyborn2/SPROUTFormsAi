/**
 * Role capability defaults.
 *
 * The definitions live in `@formai/shared` beside the matrix types and scope
 * resolvers they describe. This module re-exports them so `@formai/db`
 * consumers (notably tenant provisioning, which seeds `role_permissions` on org
 * creation) keep their existing import path.
 */
export { DEFAULT_ROLE_PERMISSIONS, defaultMatrixFor } from '@formai/shared';
