import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DURATION,
  FPS,
  scenes,
  sceneAt,
  sourceFrameAt,
  typed,
  pastedAddress,
} from "./timeline.ts";

test("47.5-second cut has contiguous shots and reaches each action outcome", () => {
  assert.equal(DURATION, 47.5 * FPS);
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    assert.equal(s.start, i === 0 ? 0 : scenes[i - 1].end);
    assert.equal(sceneAt(s.start * FPS).id, s.id);
    assert.equal(sourceFrameAt(s.start * FPS), s.sourceStart);
    assert.equal(sourceFrameAt(s.end * FPS - 1), s.sourceEnd);
  }
  const outcomes = {
    enable: 215,
    connect: 225,
    github: 110,
    secrets: 150,
    backup: 130,
    handoff: 110,
    network: 230,
    ssh: 790,
  };
  for (const [id, frame] of Object.entries(outcomes))
    assert.ok(scenes.find((s) => s.id === id)!.sourceEnd >= frame);
});
test("reverse seeking restores the exact fixture frame", () => {
  const forward = Array.from({ length: DURATION }, (_, f) => [
    sceneAt(f).id,
    sourceFrameAt(f),
  ]);
  for (const f of [DURATION - 1, 0, 850, 720, 285, 435, 700, 95])
    assert.deepEqual([sceneAt(f).id, sourceFrameAt(f)], forward[f]);
  assert.equal(typed("hello", 14, 10, 2), "he");
});

test("connection pastes the complete address in a single step", () => {
  assert.equal(pastedAddress("developer@office-mac.local", 84), "");
  assert.equal(
    pastedAddress("developer@office-mac.local", 85),
    "developer@office-mac.local",
  );
});
test("SSH follows the browser preview and ends with remote agent activity", () => {
  assert.equal(sceneAt(26.5 * FPS - 1).id, "network");
  assert.equal(sceneAt(26.5 * FPS).id, "ssh");
  assert.equal(sceneAt(46.5 * FPS - 1).id, "ssh");
  assert.equal(sourceFrameAt(46.5 * FPS - 1), 809);
  assert.equal(sceneAt(46.5 * FPS).id, "outro");
});
