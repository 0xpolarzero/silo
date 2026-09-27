import { Composition } from "remotion";
import { sshTiming } from "./ssh-timeline";
import { SshFilm } from "./ssh-film";
import "./ssh-style.css";
import { Film } from "./film";
import { DURATION, FPS, WIDTH, HEIGHT } from "./timeline";
import "./app.generated.css";
import "./style.css";
import { ReleaseFilm } from "./release-film";
import { RELEASE_DURATION, RELEASE_FPS } from "./release-timeline";
export const Root = () => (
  <>
    <Composition
      id="SiloRelease"
      component={ReleaseFilm}
      durationInFrames={RELEASE_DURATION}
      fps={RELEASE_FPS}
      width={WIDTH}
      height={HEIGHT}
    />
    <Composition
      id="SiloDemo"
      component={Film}
      durationInFrames={DURATION}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
    <Composition
      id="SiloSshDemo"
      component={SshFilm}
      durationInFrames={sshTiming.duration}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  </>
);
