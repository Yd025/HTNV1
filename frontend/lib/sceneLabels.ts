export type ScreenLabel = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

const LABEL_GAP = 6;
const VIEWPORT_MARGIN = 8;
const POSITION_EPSILON = 0.000001;

function clampCenter(center: number, size: number, viewportSize: number): number {
  const minimum = VIEWPORT_MARGIN + size / 2;
  const maximum = viewportSize - VIEWPORT_MARGIN - size / 2;
  return minimum > maximum ? viewportSize / 2 : Math.min(maximum, Math.max(minimum, center));
}

/** Keep fleet labels near their projections, preferring vertical separation. */
export function layoutFleetLabels(
  labels: ScreenLabel[],
  viewport: { width: number; height: number },
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const placed: ScreenLabel[] = [];
  const ordered = [...labels].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const label of ordered) {
    let x = clampCenter(label.x, label.width, viewport.width);
    const anchorY = clampCenter(label.y, label.height, viewport.height);
    function findFreeY(candidateX: number): number | undefined {
      const neighbors = placed.filter(
        (previous) => Math.abs(candidateX - previous.x) < (label.width + previous.width) / 2 + LABEL_GAP - POSITION_EPSILON,
      );
      const candidates = [anchorY];
      for (const previous of neighbors) {
        const separation = (label.height + previous.height) / 2 + LABEL_GAP;
        candidates.push(
          clampCenter(previous.y - separation, label.height, viewport.height),
          clampCenter(previous.y + separation, label.height, viewport.height),
        );
      }
      candidates.sort((a, b) => Math.abs(a - label.y) - Math.abs(b - label.y) || a - b);
      return candidates.find((candidate) =>
        neighbors.every(
          (previous) => Math.abs(candidate - previous.y) >= (label.height + previous.height) / 2 + LABEL_GAP - POSITION_EPSILON,
        ),
      );
    }

    let freeY = findFreeY(x);
    if (freeY === undefined) {
      let nearestDistance = Infinity;
      // A full vertical column may still have room on either side.
      for (const previous of placed) {
        const separation = (label.width + previous.width) / 2 + LABEL_GAP;
        for (const side of [-1, 1]) {
          const candidateX = clampCenter(previous.x + side * separation, label.width, viewport.width);
          const candidateY = findFreeY(candidateX);
          if (candidateY === undefined) continue;
          const distance = (candidateX - label.x) ** 2 + (candidateY - label.y) ** 2;
          if (distance < nearestDistance) {
            nearestDistance = distance;
            x = candidateX;
            freeY = candidateY;
          }
        }
      }
    }
    // An overcrowded viewport may have no free slot; retain the clamped anchor.
    const y = freeY ?? anchorY;
    placed.push({ ...label, x, y });
    positions.set(label.id, { x, y });
  }

  return positions;
}
