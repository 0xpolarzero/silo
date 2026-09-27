import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RELEASE_DURATION, RELEASE_FPS, agentTaskAt, releaseScenes, releaseSshAt } from './release-timeline.ts';

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

test('SSH client connects only after network access and key handoff, before remote activity', () => {
  assert.equal(releaseSshAt(29).local, false);
  assert.equal(releaseSshAt(30).local, true);
  assert.equal(releaseSshAt(59).network, false);
  assert.equal(releaseSshAt(60).network, true);
  assert.equal(releaseSshAt(149).keySaved, false);
  assert.equal(releaseSshAt(150).keySaved, true);
  assert.equal(releaseSshAt(204).connecting, false);
  assert.equal(releaseSshAt(230).connected, true);
  assert.equal(releaseSshAt(284).working, false);
  assert.equal(releaseSshAt(285).working, true);
  assert.equal(releaseSshAt(0).connected, false);
});

test('the website tour includes both backup and SSH handoff demonstrations', () => {
  const names = releaseScenes.map(scene => scene.id as string);
  assert.ok(names.includes('backup'), 'Backup feature links need an actual backup scene');
  assert.ok(names.includes('ssh'), 'SSH feature links need an actual SSH scene');
});

test('the illustrated agent acts before displaying and verifying its result', () => {
  assert.deepEqual(agentTaskAt(0), { observe: false, click: false, created: false, checked: false });
  assert.deepEqual(agentTaskAt(112), { observe: true, click: true, created: false, checked: false });
  assert.equal(agentTaskAt(148).created, true);
  assert.equal(agentTaskAt(189).checked, false);
  assert.equal(agentTaskAt(190).checked, true);
  assert.equal(agentTaskAt(51).observe, false);
});
