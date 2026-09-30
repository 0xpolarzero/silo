import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { initializeTour } from "../src/tour.js";
import {
  RELEASE_DURATION,
  RELEASE_FPS,
  releaseScenes,
} from "../../demo/src/release-timeline.ts";

const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const captions = readFileSync(new URL("../public/media/tour.vtt", import.meta.url), "utf8");
const transcript = readFileSync(new URL("../public/media/tour-transcript.txt", import.meta.url), "utf8");
const duration = RELEASE_DURATION / RELEASE_FPS;
const scenes = new Map(releaseScenes.map((scene) => [scene.id, scene.from / RELEASE_FPS]));
const chapterScenes = new Map([
  ["Agent desktop", "desktop"],
  ["Computers", "computers"],
  ["Editor & terminal", "tools"],
  ["SSH & agents", "ssh"],
  ["GitHub", "github"],
  ["Secrets", "secrets"],
  ["Export and Import", "backup"],
  ["Networking", "preview"],
]);
const categoryScenes = new Map([
  ["Watch the remote computer demonstration", "computers"],
  ["Watch the editor and agent SSH demonstration", "ssh"],
  ["Watch the development server demonstration", "preview"],
  ["Watch the GitHub access demonstration", "github"],
  ["Watch the secrets demonstration", "secrets"],
  ["Watch the sandbox export and import demonstration", "backup"],
]);
const seconds = (timestamp) => timestamp.split(":").reduce((total, part) => total * 60 + Number(part), 0);

test("every category opens its matching film scene, and chapter buttons follow film order", () => {
  const dom = new JSDOM(markup);
  const { document } = dom.window;
  const chapters = [...document.querySelectorAll("[data-chapter]")];
  assert.equal(chapters.length, chapterScenes.size);
  let previous = -1;
  for (const button of chapters) {
    const scene = chapterScenes.get(button.textContent.trim());
    assert.ok(scene, `Unknown chapter: ${button.textContent}`);
    const start = Number(button.dataset.chapter);
    assert.equal(start, scenes.get(scene), `${scene} must start with the film scene`);
    assert.ok(start > previous && start < duration, `${scene} must be ordered and inside the film`);
    previous = start;
  }
  const categories = [...document.querySelectorAll("[data-tour][aria-label]")];
  assert.equal(categories.length, categoryScenes.size);
  for (const button of categories) {
    const scene = categoryScenes.get(button.getAttribute("aria-label"));
    assert.ok(scene, `Unknown category: ${button.getAttribute("aria-label")}`);
    assert.equal(Number(button.dataset.tour), scenes.get(scene), `${scene} category destination`);
    assert.ok(chapters.some((chapter) => chapter.dataset.chapter === button.dataset.tour));
  }
  const durationLabel = `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")}`;
  assert.equal(document.querySelector('[data-tour="0"] .muted').textContent, durationLabel);
  dom.window.close();
});

test("captions cover every film scene without gaps, overlap, or cues beyond its duration", () => {
  assert.ok(captions.startsWith("WEBVTT\n"));
  const cues = [...captions.matchAll(/^(\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}\.\d{3})\n([^]+?)(?=\n\n|$)/gm)];
  assert.equal(cues.length, releaseScenes.length);
  for (const [index, cue] of cues.entries()) {
    const scene = releaseScenes[index];
    assert.equal(seconds(cue[1]), scene.from / RELEASE_FPS, `${scene.id} caption start`);
    assert.equal(seconds(cue[2]), (scene.from + scene.duration) / RELEASE_FPS, `${scene.id} caption end`);
    assert.ok(cue[3].trim().length > 0);
  }
  assert.equal(seconds(cues.at(-1)[2]), duration);
});

test("the transcript names the current duration and describes every scene at its start", () => {
  assert.match(transcript, new RegExp(`\\(${duration} seconds\\)`));
  const entries = [...transcript.matchAll(/^(\d+:\d{2}) — (.+)$/gm)];
  assert.deepEqual(entries.map((entry) => seconds(entry[1])), [...scenes.values()]);
  assert.match(transcript, /illustrat/i);
  assert.match(transcript, /sample data/);
});

function setupPlayer() {
  const dom = new JSDOM(markup);
  const { document } = dom.window;
  const video = document.querySelector("video");
  const dialog = document.querySelector("dialog");
  Object.defineProperty(video, "duration", { value: duration, writable: true });
  let plays = 0;
  let pauses = 0;
  video.play = () => { plays++; return Promise.resolve(); };
  video.pause = () => { pauses++; };
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new dom.window.Event("close")); };
  initializeTour(document);
  return {
    dom, document, video, dialog,
    plays: () => plays,
    pauses: () => pauses,
    active: () => document.querySelector('[data-chapter][aria-current="true"]')?.textContent.trim(),
    update(time, event = "timeupdate") {
      video.currentTime = time;
      video.dispatchEvent(new dom.window.Event(event));
    },
  };
}

test("category and chapter clicks seek, play, and select the matching chapter", () => {
  const player = setupPlayer();
  let clicks = 0;
  for (const button of player.document.querySelectorAll("[data-tour], [data-chapter]")) {
    button.click();
    clicks++;
    assert.equal(player.dialog.open, true);
    assert.equal(player.video.currentTime, Number(button.dataset.tour ?? button.dataset.chapter));
    player.update(player.video.currentTime);
    const chapter = player.document.querySelector(`[data-chapter="${player.video.currentTime}"]`);
    assert.equal(player.active(), chapter?.textContent.trim());
  }
  assert.equal(player.plays(), clicks);
  const opener = player.document.querySelector('[data-tour="0"]');
  opener.click();
  player.document.querySelector(".close-button").click();
  assert.equal(player.dialog.open, false);
  assert.equal(player.pauses(), 1);
  assert.equal(player.document.activeElement, opener);
  player.dom.window.close();
});

test("chapter selection follows boundaries and the final chapter lasts until the media duration", () => {
  const player = setupPlayer();
  for (const [name, scene] of chapterScenes) {
    player.update(scenes.get(scene));
    assert.equal(player.active(), name);
  }
  player.update(duration - 0.01);
  assert.equal(player.active(), "Networking");
  player.update(duration, "ended");
  assert.equal(player.active(), undefined);
  // The last chapter must also follow media metadata if the encoded duration changes.
  player.video.duration = duration + 2;
  player.update(duration + 1, "durationchange");
  assert.equal(player.active(), "Networking");
  player.update(duration + 2);
  assert.equal(player.active(), undefined);
  player.dom.window.close();
});
