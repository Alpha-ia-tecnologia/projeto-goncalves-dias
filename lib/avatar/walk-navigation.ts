import { STUDY_ROTATION } from "./stage-framing";

export type WalkPoint = readonly [number, number];
type Point = [number, number];
type Rectangle = readonly [number, number, number, number]; // minX, maxX, minZ, maxZ

const BODY_MARGIN = 0.55;
const GRID_STEP = 0.2;
const cosine = Math.cos(STUDY_ROTATION);
const sine = Math.sin(STUDY_ROTATION);
// Deliberately reserve the central floor, away from the outer furniture aisles.
const CENTER_AREA: Rectangle = [-2.6, 2.65, -2.6, 2.7];

function roomPoint(x: number, z: number): Point {
  return [cosine * x - sine * z, sine * x + cosine * z];
}

function worldPoint(x: number, z: number): Point {
  return [cosine * x + sine * z, -sine * x + cosine * z];
}

/** Room-space extent including the visitor-facing body, useful for overview cameras. */
export const WALK_ROOM_BOUNDS = {
  minX: CENTER_AREA[0] - BODY_MARGIN,
  maxX: CENTER_AREA[1] + BODY_MARGIN,
  minZ: CENTER_AREA[2] - BODY_MARGIN,
  maxZ: CENTER_AREA[3] + BODY_MARGIN,
} as const;

const corners = [
  worldPoint(CENTER_AREA[0], CENTER_AREA[2]), worldPoint(CENTER_AREA[0], CENTER_AREA[3]),
  worldPoint(CENTER_AREA[1], CENTER_AREA[2]), worldPoint(CENTER_AREA[1], CENTER_AREA[3]),
];
/** World-space [minX, maxX, minZ, maxZ], including a 0.55 m body margin. */
export const WALK_BOUNDS: readonly [number, number, number, number] = [
  Math.min(...corners.map(([x]) => x)) - BODY_MARGIN,
  Math.max(...corners.map(([x]) => x)) + BODY_MARGIN,
  Math.min(...corners.map(([, z]) => z)) - BODY_MARGIN,
  Math.max(...corners.map(([, z]) => z)) + BODY_MARGIN,
];

export const WALK_DESTINATIONS: readonly { id: string; label: string; position: WalkPoint }[] = [
  { id: "quadro", label: "Voltar ao quadro", position: [0, 0] },
  { id: "estante", label: "Perto da estante", position: worldPoint(-2.3, 1.1) },
  { id: "escrivaninha", label: "Perto da escrivaninha", position: worldPoint(-1, -0.95) },
  { id: "janelas", label: "Perto das janelas", position: worldPoint(2.3, 1.5) },
  { id: "fundo", label: "Ao fundo do gabinete", position: worldPoint(0, -2.3) },
];

function padded(bounds: Rectangle): Rectangle {
  return [bounds[0] - BODY_MARGIN, bounds[1] + BODY_MARGIN, bounds[2] - BODY_MARGIN, bounds[3] + BODY_MARGIN];
}

// Measured footprints from the supplied room GLB, rounded outwards. These cover
// table tops, chair backs, open shutters, curtains and foliage, not only the feet.
const roomFootprints: readonly Rectangle[] = [
  [-4.38, -3.50, -0.14, 2.54], // bookcase
  [-3.93, -2.97, -2.35, -0.51], // writing desk
  [-2.69, -2.02, -1.65, -1.05], // chair
  [-4.42, -4.18, -3.24, -1.93], // door trim
  [3.68, 4.54, -2.72, 2.72], // open windows and curtains
  [3.54, 4.14, -0.34, 0.49], // side table and lamp
  [2.31, 4.00, -3.62, -1.86], // plant including its fronds
];
const roomObstacles = roomFootprints.map(padded);
// The chat pedestal stays frontal in world space, independently of room rotation.
// Bounds include its entire frame and base at X=1.9, Z=0.15, uniform scale=1.3.
const pedestalObstacle = padded([1.9 - 0.594 * 1.3, 1.9 + 0.594 * 1.3, 0.15 - 0.335 * 1.3, 0.15 + 0.335 * 1.3]);

function inside(x: number, z: number, box: Rectangle) {
  return x >= box[0] && x <= box[1] && z >= box[2] && z <= box[3];
}

/** Test a walking centre in world X/Z coordinates, with body clearance included. */
export function isWalkable(x: number, z: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  const local = roomPoint(x, z);
  return inside(local[0], local[1], CENTER_AREA)
    && !inside(x, z, pedestalObstacle)
    && !roomObstacles.some((box) => inside(local[0], local[1], box));
}

/** Closed slab intersection rejects even a segment merely grazing an obstacle corner. */
function crossesRectangle(from: WalkPoint, to: WalkPoint, box: Rectangle) {
  let enter = 0;
  let leave = 1;
  for (let axis = 0; axis < 2; axis++) {
    const start = from[axis];
    const delta = to[axis] - start;
    const low = box[axis * 2];
    const high = box[axis * 2 + 1];
    if (Math.abs(delta) < 1e-12) {
      if (start < low || start > high) return false;
    } else {
      const a = (low - start) / delta;
      const b = (high - start) / delta;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
      if (enter > leave) return false;
    }
  }
  return true;
}

function clearSegment(from: WalkPoint, to: WalkPoint) {
  if (!isWalkable(from[0], from[1]) || !isWalkable(to[0], to[1])) return false;
  if (crossesRectangle(from, to, pedestalObstacle)) return false;
  const localFrom = roomPoint(from[0], from[1]);
  const localTo = roomPoint(to[0], to[1]);
  // The centre area is convex, so valid endpoints also keep its whole segment inside.
  return !roomObstacles.some((box) => crossesRectangle(localFrom, localTo, box));
}

function distance(a: WalkPoint, b: WalkPoint) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

type GridNode = { position: Point; neighbors: { index: number; cost: number }[] };
let gridCache: GridNode[] | undefined;
function grid() {
  if (gridCache) return gridCache;
  const nodes: GridNode[] = [];
  const indices = new Map<string, number>();
  const cells: [number, number][] = [];
  for (let x = Math.floor(WALK_BOUNDS[0] / GRID_STEP); x <= Math.ceil(WALK_BOUNDS[1] / GRID_STEP); x++) {
    for (let z = Math.floor(WALK_BOUNDS[2] / GRID_STEP); z <= Math.ceil(WALK_BOUNDS[3] / GRID_STEP); z++) {
      const position: Point = [x * GRID_STEP, z * GRID_STEP];
      if (!isWalkable(...position)) continue;
      indices.set(`${x},${z}`, nodes.length);
      cells.push([x, z]);
      nodes.push({ position, neighbors: [] });
    }
  }
  nodes.forEach((node, index) => {
    const [x, z] = cells[index];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      const neighbor = indices.get(`${x + dx},${z + dz}`);
      if (neighbor !== undefined && clearSegment(node.position, nodes[neighbor].position)) {
        node.neighbors.push({ index: neighbor, cost: GRID_STEP * Math.hypot(dx, dz) });
      }
    }
  });
  gridCache = nodes;
  return nodes;
}

type QueueEntry = { index: number; cost: number; estimate: number };
class MinQueue {
  private entries: QueueEntry[] = [];
  push(entry: QueueEntry) {
    let index = this.entries.push(entry) - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.entries[parent].estimate <= entry.estimate) break;
      this.entries[index] = this.entries[parent];
      index = parent;
    }
    this.entries[index] = entry;
  }
  pop(): QueueEntry | undefined {
    const first = this.entries[0];
    const last = this.entries.pop();
    if (!this.entries.length || !last) return first;
    let index = 0;
    while (index * 2 + 1 < this.entries.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.entries.length && this.entries[child + 1].estimate < this.entries[child].estimate) child++;
      if (last.estimate <= this.entries[child].estimate) break;
      this.entries[index] = this.entries[child];
      index = child;
    }
    this.entries[index] = last;
    return first;
  }
}

function simplify(points: Point[]) {
  const result: Point[] = [points[0]];
  let current = 0;
  while (current < points.length - 1) {
    let next = points.length - 1;
    while (next > current + 1 && !clearSegment(points[current], points[next])) next--;
    if (distance(result[result.length - 1], points[next]) > 1e-8) result.push(points[next]);
    current = next;
  }
  return result;
}

/**
 * Return [from, ...safe waypoints, to], or null for an invalid/unreachable point.
 * Follow these straight segments; an interpolating spline could cut a corner.
 * Replanning from the current interpolated position supports mid-walk redirection.
 * A destination already reached returns one fresh point and needs no movement.
 */
export function planWalkPath(from: WalkPoint, to: WalkPoint): Point[] | null {
  if (!from || !to || !isWalkable(from[0], from[1]) || !isWalkable(to[0], to[1])) return null;
  const start: Point = [from[0], from[1]];
  const target: Point = [to[0], to[1]];
  if (distance(start, target) < 1e-8) return [start];
  if (clearSegment(start, target)) return [start, target];
  const nodes = grid();
  const costs = new Float64Array(nodes.length).fill(Infinity);
  const previous = new Int32Array(nodes.length).fill(-1);
  const settled = new Uint8Array(nodes.length);
  const queue = new MinQueue();
  // Visible links retain arbitrary click positions instead of snapping the user
  // onto the grid, and keep starts close to boundaries reachable.
  nodes.forEach((node, index) => {
    if (!clearSegment(start, node.position)) return;
    const cost = distance(start, node.position);
    costs[index] = cost;
    queue.push({ index, cost, estimate: cost + distance(node.position, target) });
  });
  let entry: QueueEntry | undefined;
  while ((entry = queue.pop())) {
    const { index, cost } = entry;
    if (settled[index] || cost !== costs[index]) continue;
    const node = nodes[index];
    settled[index] = 1;
    if (clearSegment(node.position, target)) {
      const path: Point[] = [target];
      for (let current = index; current !== -1; current = previous[current]) path.push([...nodes[current].position]);
      path.push(start);
      return simplify(path.reverse());
    }
    for (const neighbor of node.neighbors) {
      if (settled[neighbor.index]) continue;
      const nextCost = cost + neighbor.cost;
      if (nextCost >= costs[neighbor.index]) continue;
      costs[neighbor.index] = nextCost;
      previous[neighbor.index] = index;
      queue.push({ index: neighbor.index, cost: nextCost, estimate: nextCost + distance(nodes[neighbor.index].position, target) });
    }
  }
  return null;
}