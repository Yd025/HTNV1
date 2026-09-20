const nonNegative = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

/** Floor lookup on chronological frames; retain the first/last frame outside its range. */
export function frameIndexAtTime(frames: ReadonlyArray<{ time: number }>, seconds: number): number {
  if (!frames.length) return -1;
  const target = nonNegative(seconds);
  let low = 0, high = frames.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (frames[middle].time <= target) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

/** Advance active playback seconds without mutating the recording or its outcome. */
export function advancePlayback(current: number, elapsed: number, duration: number, loop: boolean): { time: number; ended: boolean } {
  const end = nonNegative(duration);
  if (end === 0) return { time: 0, ended: true };
  const time = Math.min(nonNegative(current), end), delta = nonNegative(elapsed);
  if (!loop) {
    return delta >= end - time ? { time: end, ended: true } : { time: time + delta, ended: false };
  }
  // Reduce the delta before adding, so a large background gap cannot overflow.
  const remainder = delta % end, untilEnd = end - time;
  return { time: remainder >= untilEnd ? remainder - untilEnd : time + remainder, ended: false };
}
