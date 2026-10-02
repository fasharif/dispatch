import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATUSES,
  InvalidTransitionError,
  assertTransition,
  canTransition,
  isTerminal,
} from './delivery.js';

describe('delivery state machine', () => {
  it('follows the happy path', () => {
    expect(canTransition('pending', 'assigned')).toBe(true);
    expect(canTransition('assigned', 'picked_up')).toBe(true);
    expect(canTransition('picked_up', 'delivered')).toBe(true);
  });

  it('allows re-assignment only before pickup', () => {
    expect(canTransition('assigned', 'assigned')).toBe(true);
    expect(canTransition('picked_up', 'assigned')).toBe(false);
  });

  it('never skips pickup or leaves a terminal state', () => {
    expect(canTransition('assigned', 'delivered')).toBe(false);
    expect(canTransition('pending', 'picked_up')).toBe(false);
    for (const terminal of ['delivered', 'failed', 'cancelled'] as const) {
      expect(isTerminal(terminal)).toBe(true);
      for (const next of DELIVERY_STATUSES) expect(canTransition(terminal, next)).toBe(false);
    }
  });

  it('lets a delivery fail only once a driver has it', () => {
    expect(canTransition('pending', 'failed')).toBe(false);
    expect(canTransition('assigned', 'failed')).toBe(true);
    expect(canTransition('picked_up', 'failed')).toBe(true);
  });

  it('throws a typed error for an invalid move', () => {
    expect(() => {
      assertTransition('delivered', 'cancelled');
    }).toThrow(InvalidTransitionError);
    expect(() => {
      assertTransition('delivered', 'cancelled');
    }).toThrow('A delivery cannot move from delivered to cancelled');
  });
});
