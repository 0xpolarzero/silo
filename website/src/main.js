import { linuxDownloads } from "./downloads.js";

const architecture = document.querySelector("#linux-architecture");
function updateDownloads() {
  const urls = linuxDownloads(architecture.value);
  document.querySelector("#linux-download").href = urls.deb;
  document.querySelector("#appimage-download").href = urls.appImage;
  document
    .querySelector("#linux-download")
    .setAttribute(
      "aria-label",
      `Download Silo for Linux ${architecture.value}, Debian package`,
    );
  document
    .querySelector("#appimage-download")
    .setAttribute(
      "aria-label",
      `Download Silo for Linux ${architecture.value}, AppImage`,
    );
}
architecture.addEventListener("change", updateDownloads);
updateDownloads();

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectWorkflow(tab, focus = false) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute("aria-controls")).hidden =
      !selected;
  }
  if (focus) tab.focus();
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => selectWorkflow(tab));
  tab.addEventListener("keydown", (event) => {
    const next = {
      ArrowDown: (index + 1) % tabs.length,
      ArrowUp: (index + tabs.length - 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectWorkflow(tabs[next], true);
  });
}

const dialog = document.querySelector("#tour-dialog");
const video = document.querySelector("#tour-video");
const videoError = document.querySelector("#video-error");
const chapters = [...document.querySelectorAll("[data-chapter]")];
let opener;
function playFrom(time) {
  videoError.hidden = true;
  video.currentTime = time;
  video.play().catch(() => {
    // Native controls stay available when the browser declines playback.
    if (video.error) videoError.hidden = false;
  });
}
for (const button of document.querySelectorAll("[data-tour]")) {
  button.addEventListener("click", () => {
    opener = button;
    dialog.showModal();
    playFrom(Number(button.dataset.tour));
  });
}
for (const button of chapters)
  button.addEventListener("click", () =>
    playFrom(Number(button.dataset.chapter)),
  );
video.addEventListener("error", () => {
  videoError.hidden = false;
});
video.addEventListener("timeupdate", () => {
  for (const [index, button] of chapters.entries()) {
    const active =
      video.currentTime >= Number(button.dataset.chapter) &&
      video.currentTime < Number(chapters[index + 1]?.dataset.chapter ?? 48);
    if (active) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
});
document
  .querySelector(".close-button")
  .addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  const bounds = dialog.getBoundingClientRect();
  if (
    event.target === dialog &&
    (event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom)
  )
    dialog.close();
});
dialog.addEventListener("close", () => {
  video.pause();
  opener?.focus({ preventScroll: true });
});
