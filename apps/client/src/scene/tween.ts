import type { Scene } from '@babylonjs/core';

export type Easing = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  outBounce: (t: number) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
} satisfies Record<string, Easing>;

/** True while the page is in a background tab: animations are skipped, not paused. */
function skipAnimations(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

/**
 * Frame-driven tween. `update` receives the eased progress in [0,1].
 * Resolves after the final frame; in hidden tabs it jumps to the end.
 */
export function tween(
  scene: Scene,
  durationMs: number,
  update: (t: number) => void,
  easing: Easing = ease.outCubic,
  delayMs = 0,
): Promise<void> {
  return new Promise((resolve) => {
    if (skipAnimations() || durationMs <= 0) {
      update(easing(1));
      resolve();
      return;
    }
    let elapsed = -delayMs;
    const observer = scene.onBeforeRenderObservable.add(() => {
      elapsed += scene.getEngine().getDeltaTime();
      if (skipAnimations()) elapsed = durationMs;
      if (elapsed < 0) return;
      const t = Math.min(1, elapsed / durationMs);
      update(easing(t));
      if (t >= 1) {
        scene.onBeforeRenderObservable.remove(observer);
        resolve();
      }
    });
  });
}

export function wait(scene: Scene, ms: number): Promise<void> {
  return tween(scene, ms, () => {}, ease.linear);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
