/**
 * @formai/db — Drizzle schema, client factory, and seed helpers.
 */

export * as schema from './schema/index.js';
export { createDb, type Db } from './client.js';
export { DEFAULT_ROLE_PERMISSIONS, defaultMatrixFor } from './permissions.js';
export { PLAN_CONFIG, PLAN_TIERS, type PlanTier, type AccountKind, type PlanFeatures, type PlanConfig } from './plans.js';
