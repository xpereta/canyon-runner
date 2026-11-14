// Canyon Runner — quaternion attitude math (flight agent).
// LOCKED conventions (CONTRACT.md):
//   World axes: X = east, Y = up, Z = south (north = -Z), right-handed.
//   Body (attitude identity): nose = -Z, up = +Y, right wing = +X.
//   qFromEuler(yaw,pitch,roll) = qYaw * qPitch * qRoll (applied right-to-left).
//     yaw   = heading, positive = nose right (compass/clockwise-from-above), so it is
//             a rotation about world +Y by -yawRad (identity yaw=0 faces north -Z).
//     pitch = nose up positive: rotation about body lateral +X by +pitchRad.
//     roll  = right wing down positive: rotation about body longitudinal (-Z) by +rollRad,
//             i.e. rotation about world/local +Z by -rollRad.
//   qFromEuler(0,0,0) maps nose (0,0,-1) -> (0,0,-1); qFromEuler(pi/2,0,0) -> +X (east).

export function qFromEuler(yawRad, pitchRad, rollRad) {
  // qYaw = rotY(-yaw), qPitch = rotX(+pitch), qRoll = rotZ(-roll)
  const cy = Math.cos(yawRad * 0.5), sy = -Math.sin(yawRad * 0.5);
  const cp = Math.cos(pitchRad * 0.5), sp = Math.sin(pitchRad * 0.5);
  const cr = Math.cos(rollRad * 0.5), sr = -Math.sin(rollRad * 0.5);
  const qYaw = [0, sy, 0, cy];
  const qPitch = [sp, 0, 0, cp];
  const qRoll = [0, 0, sr, cr];
  return qMul(qMul(qYaw, qPitch), qRoll);
}

// Hamilton product: M(qMul(a,b)) = M(a) * M(b) (rotate right-to-left).
export function qMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by + ay * bw + az * bx - ax * bz,
    aw * bz + az * bw + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function qNormalize(q) {
  const [x, y, z, w] = q;
  const n = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  return [x / n, y / n, z / n, w / n];
}

export function qConjugate(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

// Rotate world vector v into q's frame? No: q maps BODY -> WORLD here
// (attitude quaternion: qRotate(q, bodyVec) = worldVec). v = {x,y,z} -> {x,y,z}.
export function qRotate(q, v) {
  const [x, y, z, w] = q;
  // t = 2 * q_vec x v
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

const PITCH_CLAMP = 85 * Math.PI / 180; // deg->rad, LOCKED clamp

// Inverse of qFromEuler. For q = qYaw*qPitch*qRoll the active rotation matrix is
// R = Ry(-yaw) * Rx(pitch) * Rz(-roll), whose quaternion-derived elements are
// (standard q*v*q* matrix): R10=2(xy+wz), R11=1-2(x^2+z^2), R12=2(yz-xw),
// R02=2(xz+wy), R22=1-2(x^2+y^2).
// R12 = -sin(pitch); row1 gives roll; column2 rows 0/2 give yaw.
export function eulerFromQ(q) {
  const [x, y, z, w] = q;
  const R12 = 2 * (y * z - x * w);
  let pitch = Math.asin(Math.max(-1, Math.min(1, -R12)));
  if (pitch > PITCH_CLAMP) pitch = PITCH_CLAMP;
  else if (pitch < -PITCH_CLAMP) pitch = -PITCH_CLAMP;
  const R10 = 2 * (x * y + w * z);        // = cb*sc
  const R11 = 1 - 2 * (x * x + z * z);    // = cb*cc
  const rollAngle = Math.atan2(R10, R11); // c = -rollRad
  const R02 = 2 * (x * z + w * y);        // = sa*cb
  const R22 = 1 - 2 * (x * x + y * y);    // = ca*cb
  const yawAngle = Math.atan2(R02, R22);  // a = -yawRad
  return { yaw: -yawAngle, pitch, roll: -rollAngle };
}
