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
  liveEditState,
} from "./timeline.ts";

test("35-second cut has contiguous shots and reaches each action outcome", () => {
  assert.equal(DURATION, 35 * FPS);
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
    edit: 185,
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
test("port and editor launch precede the live update, which follows save", () => {
  assert.ok(
    scenes.findIndex((s) => s.id === "network") <
      scenes.findIndex((s) => s.id === "files"),
  );
  assert.ok(
    scenes.findIndex((s) => s.id === "files") <
      scenes.findIndex((s) => s.id === "edit"),
  );
  assert.deepEqual(liveEditState(154), { saved: false, browserUpdated: false });
  assert.deepEqual(liveEditState(155), { saved: true, browserUpdated: false });
  assert.deepEqual(liveEditState(170), { saved: true, browserUpdated: true });
});
