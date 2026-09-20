import assert from 'node:assert/strict';
import test from 'node:test';
import { BadgeInput } from '../lib/badgeInput';
import { emptyBadgeButtons } from '../lib/badgeControllerTypes';

test('badge and keyboard combine without one device releasing another', () => {
  const input = new BadgeInput();
  input.update({ ...emptyBadgeButtons(), up: true, right: true });
  assert.deepEqual(input.merge({ throttle: 0, steer: -1 }), { throttle: 1, steer: 0 });
  assert.deepEqual(input.merge({ throttle: -1, steer: 1 }), { throttle: -1, steer: 1 });
  input.update(emptyBadgeButtons());
  assert.deepEqual(input.merge({ throttle: 1, steer: -1 }), { throttle: 1, steer: -1 });
});

test('held buttons require release after pause and start does not repeat', () => {
  const input = new BadgeInput();
  assert.equal(input.update({ ...emptyBadgeButtons(), start: true }).start, false);
  input.update(emptyBadgeButtons());
  const held = { ...emptyBadgeButtons(), up: true, start: true };
  assert.equal(input.update(held).start, true);
  assert.equal(input.update(held).start, false);
  input.clear();
  input.update(held);
  assert.deepEqual(input.merge({ throttle: 0, steer: 0 }), { throttle: 0, steer: 0 });
  input.update(emptyBadgeButtons());
  input.update(held);
  assert.equal(input.merge({ throttle: 0, steer: 0 }).throttle, 1);
  input.reset();
  assert.deepEqual(input.merge({ throttle: 0, steer: 0 }), { throttle: 0, steer: 0 });
  assert.equal(input.update(held).start, false);
});
