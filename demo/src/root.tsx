import { Composition } from "remotion";
import { sshTiming } from "./ssh-timeline";
import { SshFilm } from "./ssh-film";
import "./ssh-style.css";
import { Film } from "./film";
import { DURATION, FPS, WIDTH, HEIGHT } from "./timeline";
import "./app.generated.css";
import "./style.css";
export const Root = () => (
  <>
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
