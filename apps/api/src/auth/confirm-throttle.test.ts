import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIRM_LOCK_MS,
  CONFIRM_MAX_ATTEMPTS,
  CONFIRM_WINDOW_MS,
  confirmAllowed,
  recordConfirmFailure,
  recordConfirmSuccess,
  resetConfirmThrottle,
} from './confirm-throttle.js';

/**
 * The clock is an explicit parameter, so these tests drive time directly —
 * no fake timers, no real waiting.
 */

afterEach(() => resetConfirmThrottle());

const T0 = 1_000_000;

describe('confirmAllowed', () => {
  it('allows a user with no history', () => {
    expect(confirmAllowed('u1', T0)).toEqual({ allowed: true });
  });

  it('locks after the window fills, refusing before any compare would run', () => {
    for (let i = 0; i < CONFIRM_MAX_ATTEMPTS; i++) recordConfirmFailure('u1', T0 + i);
    const gate = confirmAllowed('u1', T0 + CONFIRM_MAX_ATTEMPTS);
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.retryAfterMs).toBeGreaterThan(0);
  });

  it('the lock expires on its own', () => {
    for (let i = 0; i < CONFIRM_MAX_ATTEMPTS; i++) recordConfirmFailure('u1', T0 + i);
    const afterLock = T0 + CONFIRM_MAX_ATTEMPTS - 1 + CONFIRM_LOCK_MS + 1;
    expect(confirmAllowed('u1', afterLock)).toEqual({ allowed: true });
  });

  it('failures outside the sliding window do not count toward the lock', () => {
    // Four old failures age out; four fresh ones are one short of the lock.
    for (let i = 0; i < CONFIRM_MAX_ATTEMPTS - 1; i++) recordConfirmFailure('u1', T0 + i);
    const later = T0 + CONFIRM_WINDOW_MS + 1000;
    for (let i = 0; i < CONFIRM_MAX_ATTEMPTS - 1; i++) recordConfirmFailure('u1', later + i);
    expect(confirmAllowed('u1', later + CONFIRM_MAX_ATTEMPTS)).toEqual({ allowed: true });
  });

  it('users are isolated from one another', () => {
    for (let i = 0; i < CONFIRM_MAX_ATTEMPTS; i++) recordConfirmFailure('u1', T0 + i);
    expect(confirmAllowed('u2', T0 + CONFIRM_MAX_ATTEMPTS)).toEqual({ allowed: true });
  });

  it('a success clears the slate', () => {
    for (let i = 0; i < CONFIRM_MAX_ATTEMPTS - 1; i++) recordConfirmFailure('u1', T0 + i);
    recordConfirmSuccess('u1');
    recordConfirmFailure('u1', T0 + 100);
    // One failure after the reset is nowhere near the lock.
    expect(confirmAllowed('u1', T0 + 101)).toEqual({ allowed: true });
  });
});
