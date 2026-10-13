import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundSettings, backgroundRect, backgroundTime } from '../src/background-media.js';
import { Timeline } from '../src/timeline.js';
import { GloamingKit } from '../src/engine.js';

test('cover crops and contain letterboxes with a movable anchor', () => {
  assert.deepEqual(backgroundRect(200, 100, 100, 100, backgroundSettings()), [-50, 0, 200, 100]);
  assert.deepEqual(backgroundRect(200, 100, 100, 100, backgroundSettings({ positionX: 1 })), [-100, 0, 200, 100]);
  assert.deepEqual(backgroundRect(200, 100, 100, 100, backgroundSettings({ fit: 'contain' })), [0, 25, 100, 50]);
  assert.deepEqual(backgroundRect(200, 100, 100, 100, backgroundSettings({ fit: 'stretch' })), [0, 0, 100, 100]);
});
test('video timing loops by the song clock, including speed and clip offset', () => {
  assert.deepEqual(backgroundTime(8, 3, backgroundSettings()), { time: 2, ended: false });
  assert.deepEqual(backgroundTime(4, 3, backgroundSettings({ playbackRate: 0.5, offset: 0.5 })), { time: 2.5, ended: false });
  const end = backgroundTime(8, 3, backgroundSettings({ loop: false }));
  assert.equal(end.ended, true); assert.ok(end.time < 3 && end.time > 2.99);
});
test('invalid settings fail before media replacement; numeric controls are bounded', () => {
  assert.throws(() => backgroundSettings({ fit: 'wrong' }), /fit/);
  assert.throws(() => backgroundSettings({ opacity: NaN }), /finite/);
  assert.equal(backgroundSettings({ opacity: 2 }).opacity, 1);
  assert.equal(backgroundSettings({ playbackRate: 0 }).playbackRate, 0.25);
});
test('changing only layer opacity preserves instance identity and refreshes the active spec', () => {
  const timeline = new Timeline([{ visualizations: [{ id: 'perlin-glow', opacity: 1 }] }]);
  const wanted = timeline.activeAt(0);
  const [key, spec] = [...wanted][0];
  const entry = { spec, leaving: false, viz: {} };
  const engine = { active: new Map([[key, entry]]), spawn() { assert.fail('opacity changes must not respawn'); } };
  timeline.setWindows([{ visualizations: [{ id: 'perlin-glow', opacity: 0.25 }] }]);
  GloamingKit.prototype.syncActive.call(engine, timeline.activeAt(0));
  assert.equal(engine.active.get(key), entry);
  assert.equal(entry.spec.opacity, 0.25);
  assert.equal(new Timeline([{ visualizations: ['waveform'] }]).activeAt(0).get('waveform').opacity, 1);
});
