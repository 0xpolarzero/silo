import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RELEASE_DURATION, RELEASE_FPS, agentTaskAt, releaseScenes } from './release-timeline.ts';

test('release has no gaps or overlaps and stays below the 60-second limit', () => {
  let end = 0;
  for (const scene of releaseScenes) {
    assert.equal(scene.from, end, scene.id);
    assert.ok(scene.duration > 0);
    end += scene.duration;
  }
  assert.equal(end, RELEASE_DURATION);
  assert.ok(end / RELEASE_FPS <= 60);
});

test('the illustrated agent acts before displaying and verifying its result', () => {
  assert.deepEqual(agentTaskAt(0), { observe: false, click: false, created: false, checked: false });
  assert.deepEqual(agentTaskAt(112), { observe: true, click: true, created: false, checked: false });
  assert.equal(agentTaskAt(148).created, true);
  assert.equal(agentTaskAt(189).checked, false);
  assert.equal(agentTaskAt(190).checked, true);
  assert.equal(agentTaskAt(51).observe, false);
});
