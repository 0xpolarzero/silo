import React from 'react';
import {Composition,registerRoot} from 'remotion';
import {Film} from './film';
import '../film.css';
registerRoot(()=> <Composition id="Silo" component={Film} width={1920} height={1080} fps={60} durationInFrames={1792}/>);
