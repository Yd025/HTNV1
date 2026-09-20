import { useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { snapshotGameCanvas } from '../lib/sentryGame';

/** Own the final paint so Sentry snapshots the same completed WebGL frame. */
export default function SentryCanvasRecorder() {
  const { gl } = useThree();
  useEffect(() => {
    gl.domElement.setAttribute('data-sentry-game-canvas', 'true');
    return () => { gl.domElement.removeAttribute('data-sentry-game-canvas'); };
  }, [gl]);
  useFrame(({ gl: renderer, scene, camera }) => {
    renderer.render(scene, camera);
    try { snapshotGameCanvas(renderer.domElement); } catch { /* Capture never interrupts rendering. */ }
  }, 1);
  return null;
}
