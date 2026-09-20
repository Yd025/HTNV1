import { sampleRiverHeight, type WorldData } from './game';
import type { Layout, TowerPosition } from './learningTypes';
import { FLIGHT_ALGORITHM, normalizeFlightPolicy, validFlightPolicy } from './surveillance';

/** A server-issued mission policy is pinned together with its tower layout. */
export function applyLearningLayout(world: WorldData, layout: Pick<Layout, 'towers' | 'algorithm' | 'flightPolicy'>): WorldData {
  if (layout.algorithm !== undefined && layout.algorithm !== FLIGHT_ALGORITHM) throw new Error('Unsupported flight algorithm');
  if (layout.flightPolicy !== undefined && !validFlightPolicy(layout.flightPolicy)) throw new Error('Invalid flight policy');
  return { ...applyTowerLayout(world, layout.towers), algorithm: FLIGHT_ALGORITHM, flightPolicy: normalizeFlightPolicy(layout.flightPolicy) };
}

/** Layouts change horizontal sites only; the game still owns every sensor rule. */
export function applyTowerLayout(world: WorldData, positions: TowerPosition[]): WorldData {
  if (!Array.isArray(positions) || positions.length !== world.towers.length
    || new Set(positions.map(position => position.id)).size !== world.towers.length) {
    throw new Error('Invalid tower layout');
  }
  const towers = world.towers.map(tower => {
    const position = positions.find(candidate => candidate.id === tower.id);
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)
      || Math.abs(position.x) >= world.half || Math.abs(position.z) >= world.half) {
      throw new Error('Invalid tower position');
    }
    const unchanged = position.x === tower.x && position.z === tower.z;
    const height = unchanged ? tower.height : sampleRiverHeight(world, position.x, position.z);
    if (!Number.isFinite(height) || height <= world.waterLevel) throw new Error('Tower must stand on land');
    return { ...tower, x: position.x, z: position.z, height };
  });
  return { ...world, towers };
}
