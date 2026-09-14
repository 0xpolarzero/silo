import { Composition } from "remotion";
import { Film } from "./film";
import { DURATION, FPS, WIDTH, HEIGHT } from "./timeline";
import "./app.generated.css";
import "./style.css";
export const Root = () => (
  <Composition
    id="SiloDemo"
    component={Film}
    durationInFrames={DURATION}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
  />
);
