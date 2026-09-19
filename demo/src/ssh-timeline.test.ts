import assert from "node:assert/strict";
import test from "node:test";
import {
  cursorAt,
  sshCamera,
  mainSshFrame,
  mainSshFrames,
  siloCursor,
  agentCursor,
  sshTiming as t,
} from "./ssh-timeline.ts";

test("cursor is valid at the first frame of either app and after the final action", () => {
  assert.deepEqual(cursorAt(0, siloCursor), {
    x: 1400,
    y: 360,
    pressed: false,
  });
  assert.deepEqual(cursorAt(t.agent, agentCursor), {
    x: 1370,
    y: 340,
    pressed: false,
  });
  assert.deepEqual(cursorAt(t.duration - 1, agentCursor), {
    x: 1528,
    y: 855,
    pressed: false,
  });
});

test("cursor arrives before every click and holds while its result appears", () => {
  for (const stops of [siloCursor, agentCursor]) {
    for (const [frame, x, y, click] of stops) {
      if (!click) continue;
      for (const offset of [-5, 0, 4]) {
        const position = cursorAt(frame + offset, stops);
        assert.equal(position.x, x);
        assert.equal(position.y, y);
      }
      assert.equal(cursorAt(frame, stops).pressed, true);
      assert.equal(cursorAt(frame + 4, stops).pressed, false);
    }
  }
});

test("arbitrary and reverse seeking preserve the cursor position", () => {
  const frames = [t.connected, t.name, t.submit, t.agent, t.chooseKey - 8];
  const forward = frames.map((frame) => cursorAt(frame, agentCursor));
  assert.deepEqual(
    frames
      .toReversed()
      .map((frame) => cursorAt(frame, agentCursor))
      .reverse(),
    forward,
  );
});

test("camera pulls back continuously into the laptop and never returns to close-up", () => {
  assert.deepEqual(sshCamera(t.connect), { zoom: 0, x: 0, y: 0, scale: 1 });
  const settled = sshCamera(t.connect + 48);
  assert.equal(settled.scale, 0.5700000000000001);
  assert.ok(Math.abs(100 * settled.scale + settled.x - 70) < 0.001);
  assert.ok(Math.abs(120 * settled.scale + settled.y - 307) < 0.001);
  let previous = 1;
  for (let frame = t.connect; frame < t.duration; frame++) {
    const camera = sshCamera(frame);
    assert.ok(camera.scale <= previous);
    previous = camera.scale;
    if (frame >= t.connect + 48) assert.deepEqual(camera, settled);
  }
});

test("main film retains the smooth pullback while shortening setup pauses", () => {
  assert.equal(mainSshFrames, 600);
  assert.equal(mainSshFrame(336), t.connect);
  for (let offset = 0; offset <= 48; offset++) {
    assert.equal(mainSshFrame(336 + offset), t.connect + offset);
  }
  assert.equal(mainSshFrame(444), t.openProject);
  assert.equal(mainSshFrame(510), t.submit);
  assert.equal(mainSshFrame(599), t.duration - 1);
  for (let frame = 1; frame < mainSshFrames; frame++) {
    assert.ok(mainSshFrame(frame) >= mainSshFrame(frame - 1));
  }
});
