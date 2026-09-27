export function initializeTour(document) {
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
  function updateChapter() {
    for (const [index, button] of chapters.entries()) {
      const active =
        video.currentTime >= Number(button.dataset.chapter) &&
        video.currentTime < Number(chapters[index + 1]?.dataset.chapter ?? video.duration);
      if (active) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  }
  for (const event of ["timeupdate", "loadedmetadata", "durationchange", "ended"])
    video.addEventListener(event, updateChapter);
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
}
