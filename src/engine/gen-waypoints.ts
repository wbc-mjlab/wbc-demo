/**
 * Gen command waypoints — port of deploy `gen_waypoints.cpp`.
 */

export function integrateVelToSparseWaypoints(
  vx: number,
  vy: number,
  wz: number,
  horizons: number[],
  dt: number,
  positionScale: number,
): { xy: Float32Array; ang: Float32Array } {
  if (positionScale <= 0) throw new Error('position_scale must be positive');
  const k = horizons.length;
  const xy = new Float32Array(k * 2);
  const ang = new Float32Array(k * 2);
  if (k === 0) return { xy, ang };

  let maxH = 0;
  for (const h of horizons) maxH = Math.max(maxH, h);
  const px = new Float32Array(maxH + 1);
  const py = new Float32Array(maxH + 1);
  const psi = new Float32Array(maxH + 1);

  for (let step = 0; step < maxH; step++) {
    const c = Math.cos(psi[step]!);
    const s = Math.sin(psi[step]!);
    px[step + 1] = px[step]! + (c * vx - s * vy) * dt;
    py[step + 1] = py[step]! + (s * vx + c * vy) * dt;
    psi[step + 1] = psi[step]! + wz * dt;
  }

  for (let i = 0; i < k; i++) {
    const nf = horizons[i]!;
    xy[2 * i] = px[nf]! / positionScale;
    xy[2 * i + 1] = py[nf]! / positionScale;
    const dpsi = psi[nf]!;
    ang[2 * i] = Math.cos(dpsi);
    ang[2 * i + 1] = Math.sin(dpsi);
  }
  return { xy, ang };
}

function expSmooth(current: number, target: number, dt: number, tau: number): number {
  const alpha = 1 - Math.exp(-dt / Math.max(tau, 1e-4));
  return current + alpha * (target - current);
}

/** Far horizon = intention; nearer horizons lag toward farther. Mutates `heightWp`. */
export function lowpassHeightWaypoints(
  heightWp: Float32Array,
  heightCmd: number,
  dt: number,
  horizons: number[],
  tau: number,
): void {
  const k = horizons.length;
  if (heightWp.length !== k) throw new Error('height_wp size must match horizons');
  if (k === 0) return;
  if (tau <= 0) {
    heightWp.fill(heightCmd);
    return;
  }
  heightWp[k - 1] = expSmooth(heightWp[k - 1]!, heightCmd, dt, tau);
  for (let i = k - 2; i >= 0; i--) {
    heightWp[i] = expSmooth(heightWp[i]!, heightWp[i + 1]!, dt, tau);
  }
}
