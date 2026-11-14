// Canyon Runner — low-poly aerobatic tailwheel render model (ui agent, wave 2).
// LOCKED axes (CONTRACT.md): nose = local -Z, up = +Y, right wing = +X.
// main.js sets ac.group.position/quaternion from flight state; this module only
// builds the model and animates control surfaces / prop / wheels. Model origin =
// gear-bottom reference (matches state.pos.y = gear bottom MSL), so wheel bottoms
// sit at local y = 0.
//
// Design decisions (autonomous):
// - Primitives only (Box/Cylinder/Cone/Sphere), MeshLambertMaterial, flatShading:
//   cheap on iPad, reads as charming low-poly from the 14 m chase cam.
// - ~23 meshes, ~7.4 m long, ~8.1 m span, white/red Pitts-Cub-hybrid livery.
// - Hinge sub-groups named elevatorPivot / rudderPivot / aileronR / aileronL so
//   tests (and any debug HUD) can inspect deflections via getObjectByName.
// - Sign conventions derived from quat.js (pitch = rotX(+) lifts nose -Z up):
//     elevator +1 (nose-up cmd)   -> trailing edge UP  -> pivot.rotation.x NEGATIVE
//     aileron  +1 (right wing dn) -> right aileron TE up (rot.x neg), left TE down
//     rudder   +1 (nose right cmd)-> rudder TE left     -> pivot.rotation.y NEGATIVE
//   (verified geometrically: rotX(t) moves (0,0,1) to y=-sin t; rotY(t) moves
//    (0,0,1) to x=+sin t; trailing edges are on the +Z side of their pivots.)

// CFG-REQ: RENDER.SURFACE_MAX — max visual deflection (rad) per surface:
// { elevator: 0.5, ailerons: 0.35, rudder: 0.5, flapDrop: 0.35 }
const SURFACE_MAX = { elevator: 0.5, ailerons: 0.35, rudder: 0.5, flapDrop: 0.35 };
// CFG-REQ: RENDER.SURFACE_DEBUG_GAIN — hinge-deflection multiplier while the
// HUD debug overlay is on (setDebugSurfaces(true)); makes stick-driven surface
// motion visible from the 14 m chase cam. Flap drop is NOT scaled (it is a
// setting, not a live stick command).
const SURFACE_DEBUG_GAIN = 2;
// CFG-REQ: RENDER.PROP_RATE — visual prop rev/s = IDLE + TAS * COEF * throttle, cap MAX
const PROP_IDLE = 9, PROP_COEF = 0.62, PROP_MAX = 46; // rev/s (≈540..2760 rpm)
// CFG-REQ: RENDER.TRAIL — smoke trail tuning { len: 180, size: 0.4, opacity: 0.22 }
const TRAIL_LEN = 180, TRAIL_SIZE = 0.4, TRAIL_OPACITY = 0.22;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createAircraft(THREE) {
  const group = new THREE.Group();
  group.name = 'aircraft';

  const geos = [];   // for dispose()
  const mats = [];
  const G = g => (geos.push(g), g);
  const M = m => (mats.push(m), m);

  // ---- livery (crisp white/red, Lambert = no specular cost on iPad) ----
  const mWhite = M(new THREE.MeshLambertMaterial({ color: 0xf2f2ee, flatShading: true }));
  const mRed = M(new THREE.MeshLambertMaterial({ color: 0xd63a2f, flatShading: true }));
  const mDark = M(new THREE.MeshLambertMaterial({ color: 0x3a3d42, flatShading: true }));
  const mCowl = M(new THREE.MeshLambertMaterial({ color: 0xc23327, flatShading: true }));
  const mCanopy = M(new THREE.MeshLambertMaterial({ color: 0x9fc4dd, flatShading: true, transparent: true, opacity: 0.75 }));

  function add(parent, geo, mat, name, pos, rot) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    if (pos) mesh.position.set(pos[0], pos[1], pos[2]);
    if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
    parent.add(mesh);
    return mesh;
  }

  // Strut helper: orient a thin cylinder between two points (Super Cub-ish bracing).
  function strut(parent, from, to, name, r = 0.05, mat = mDark) {
    const a = new THREE.Vector3(from[0], from[1], from[2]);
    const b = new THREE.Vector3(to[0], to[1], to[2]);
    const d = b.clone().sub(a);
    const len = d.length();
    const geo = G(new THREE.CylinderGeometry(r, r, len, 6));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    parent.add(mesh);
    return mesh;
  }

  const CYL_Z = [Math.PI / 2, 0, 0]; // cylinder axis +Y -> +Z

  // ---- fuselage: box + taper tail cone to z=+3.7 (tailwheel posture) ----
  add(group, G(new THREE.BoxGeometry(1.0, 1.1, 5.0)), mWhite, 'fuselage', [0, 1.5, 0.3]);
  add(group, G(new THREE.ConeGeometry(0.42, 0.9, 8)), mWhite, 'tailCone', [0, 1.5, 3.25], [Math.PI / 2, 0, 0]);

  // ---- cowl + spinner + prop (nose is -Z; spinner tip at z=-3.7 = forwardmost) ----
  add(group, G(new THREE.CylinderGeometry(0.62, 0.58, 0.72, 10)), mCowl, 'cowl', [0, 1.5, -2.56], CYL_Z);
  add(group, G(new THREE.ConeGeometry(0.34, 0.8, 10)), mRed, 'spinner', [0, 1.5, -3.3], [-Math.PI / 2, 0, 0]);

  const propGroup = new THREE.Group(); // spins about local Z (longitudinal axis)
  propGroup.name = 'propGroup';
  propGroup.position.set(0, 1.5, -3.12);
  group.add(propGroup);
  add(propGroup, G(new THREE.CylinderGeometry(0.12, 0.12, 0.22, 8)), mDark, 'propHub', [0, 0, 0], CYL_Z);
  // One through-center blade box = 2-blade prop (tip r = 0.9 -> ground clearance ok for taildragger)
  add(propGroup, G(new THREE.BoxGeometry(0.16, 1.8, 0.05)), mDark, 'propBlade', [0, 0, 0]);

  // ---- wings: dihedral groups rooted near centerline; ailerons on hinge pivots ----
  const DIHEDRAL = 0.075; // ~4.3 deg
  for (const side of [1, -1]) {
    const wg = new THREE.Group();
    wg.name = side > 0 ? 'wingR' : 'wingL';
    wg.position.set(0.1 * side, 1.75, -0.55);
    wg.rotation.z = DIHEDRAL * side; // right tip up for side=+1
    group.add(wg);
    add(wg, G(new THREE.BoxGeometry(4.0, 0.14, 1.5)), mWhite, `wingPanel${side > 0 ? 'R' : 'L'}`, [1.95 * side, 0, 0]);
    const piv = new THREE.Group();
    piv.name = side > 0 ? 'aileronR' : 'aileronL';
    piv.position.set(3.25 * side, 0, 0.75); // hinge at trailing edge (local +Z side)
    wg.add(piv);
    add(piv, G(new THREE.BoxGeometry(1.3, 0.1, 0.32)), mRed, `aileronSurf${side > 0 ? 'R' : 'L'}`, [0, 0, 0.16]);
    strut(group, [0.4 * side, 0.95, -0.45], [1.9 * side, 1.72, -0.55], `wingStrut${side > 0 ? 'R' : 'L'}`);
  }

  // ---- tail: stab + hinged elevator, fin + hinged rudder ----
  add(group, G(new THREE.BoxGeometry(2.6, 0.1, 1.0)), mWhite, 'stab', [0, 2.12, 2.7]);
  const elevPivot = new THREE.Group();
  elevPivot.name = 'elevatorPivot';
  elevPivot.position.set(0, 2.12, 3.2);
  group.add(elevPivot);
  add(elevPivot, G(new THREE.BoxGeometry(2.4, 0.09, 0.34)), mRed, 'elevatorSurf', [0, 0, 0.17]);

  add(group, G(new THREE.BoxGeometry(0.12, 0.95, 1.15)), mRed, 'fin', [0, 2.75, 2.6]);
  const rudPivot = new THREE.Group();
  rudPivot.name = 'rudderPivot';
  rudPivot.position.set(0, 2.72, 3.18);
  group.add(rudPivot);
  add(rudPivot, G(new THREE.BoxGeometry(0.1, 0.8, 0.36)), mWhite, 'rudderSurf', [0, 0, 0.18]);

  // ---- canopy ----
  const canopy = add(group, G(new THREE.SphereGeometry(0.62, 10, 8)), mCanopy, 'canopy', [0, 2.12, -0.9]);
  canopy.scale.set(0.52, 0.44, 0.88);

  // ---- tailwheel gear: wheels r=0.32 -> bottom exactly y=0 (gear-bottom datum) ----
  const wheelPivots = [];
  for (const side of [1, -1]) {
    strut(group, [0.55 * side, 1.35, -0.6], [0.98 * side, 0.4, -0.5], `gearStrut${side > 0 ? 'R' : 'L'}`, 0.06);
    const piv = new THREE.Group();
    piv.name = side > 0 ? 'wheelR' : 'wheelL';
    piv.position.set(1.0 * side, 0.32, -0.5);
    group.add(piv);
    wheelPivots.push({ piv, r: 0.32 });
    add(piv, G(new THREE.CylinderGeometry(0.32, 0.32, 0.19, 10)), mDark, `wheelSurf${side > 0 ? 'R' : 'L'}`, [0, 0, 0], [0, 0, Math.PI / 2]); // axle -> X
  }
  strut(group, [0, 1.02, 3.02], [0, 0.3, 3.28], 'tailStrut', 0.05);
  const tailPiv = new THREE.Group();
  tailPiv.name = 'wheelT';
  tailPiv.position.set(0, 0.15, 3.28);
  group.add(tailPiv);
  wheelPivots.push({ piv: tailPiv, r: 0.15 });
  add(tailPiv, G(new THREE.CylinderGeometry(0.15, 0.15, 0.1, 8)), mDark, 'wheelTSurf', [0, 0, 0], [0, 0, Math.PI / 2]);

  // ---- animation state ----
  const elev = elevPivot, rud = rudPivot;
  const ail = { R: group.getObjectByName('aileronR'), L: group.getObjectByName('aileronL') };
  let surfaceGain = 1; // SURFACE_DEBUG_GAIN while HUD debug overlay is visible
  let lastT = 0; // internal clock (update gets no dt per contract)
  let propAngle = 0;
  const wheelSpin = { v: 0 };

  // ---- optional smoke trail (cheap ring buffer, world space) ----
  let trail = null, trailEnabled = false, trailHead = 0, trailFilled = 0;
  const tipScratch = new THREE.Vector3();

  function ensureTrail() {
    if (trail) return;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(TRAIL_LEN * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xdddddd, size: TRAIL_SIZE, transparent: true,
      opacity: TRAIL_OPACITY, depthWrite: false, fog: false,
    });
    trail = new THREE.Points(geo, mat);
    trail.name = 'trail';
    trail.frustumCulled = false;
    trail.renderOrder = -1;
    geos.push(geo); mats.push(mat);
  }

  function dropTrailPoint() {
    if (!group.parent) return; // needs a scene to live in (world-space points)
    ensureTrail();
    if (trail.parent === null) group.parent.add(trail);
    const posAttr = trail.geometry.attributes.position;
    // emit alternating wingtip vortices
    const side = (trailHead % 2 === 0) ? 3.85 : -3.85;
    tipScratch.set(side, 1.78, 0.35).applyMatrix4(group.matrixWorld);
    const i = trailHead * 3;
    posAttr.array[i] = tipScratch.x;
    posAttr.array[i + 1] = tipScratch.y;
    posAttr.array[i + 2] = tipScratch.z;
    trailHead = (trailHead + 1) % TRAIL_LEN;
    trailFilled = Math.min(trailFilled + 1, TRAIL_LEN);
    posAttr.needsUpdate = true;
    trail.geometry.setDrawRange(0, trailFilled);
  }

  function update(state, ctl) {
    const e = clamp(ctl?.elevator ?? 0, -1, 1);
    const a = clamp(ctl?.aileron ?? 0, -1, 1);
    const r = clamp(ctl?.rudder ?? 0, -1, 1);
    const flaps = clamp(ctl?.flaps ?? state?.flaps ?? 0, 0, 1);

    // hinge deflections (signs documented at top of file); +0 normalizes -0
    elev.rotation.x = -e * SURFACE_MAX.elevator * surfaceGain + 0;
    rud.rotation.y = -r * SURFACE_MAX.rudder * surfaceGain + 0;
    ail.R.rotation.x = -a * SURFACE_MAX.ailerons * surfaceGain + flaps * SURFACE_MAX.flapDrop + 0;
    ail.L.rotation.x = a * SURFACE_MAX.ailerons * surfaceGain + flaps * SURFACE_MAX.flapDrop + 0;

    // prop spin: rev/s scales with throttle * airspeed, capped (visual only)
    const now = Date.now();
    const dt = lastT ? clamp((now - lastT) / 1000, 0, 0.1) : 0;
    lastT = now;
    const v = state?.vel;
    const tas = v ? Math.hypot(v.x, v.y, v.z) : 0;
    const throttle = clamp(state?.throttle ?? ctl?.throttle ?? 0, 0, 1);
    const revs = clamp(PROP_IDLE + tas * PROP_COEF * throttle, PROP_IDLE, PROP_MAX);
    propGroup.rotation.z = (propGroup.rotation.z + revs * Math.PI * 2 * dt) % (Math.PI * 2); // CW from pilot

    // gear wheels roll when on the ground
    if (state?.onGround) {
      const gnd = Math.hypot(v?.x ?? 0, v?.z ?? 0);
      wheelSpin.v += ((gnd / 0.32) - wheelSpin.v) * Math.min(1, dt * 8);
      for (const { piv } of wheelPivots) piv.rotation.x += wheelSpin.v * dt;
    }

    if (trailEnabled) {
      group.updateMatrixWorld(true);
      dropTrailPoint();
    }
  }

  function setTrail(enabled) {
    trailEnabled = !!enabled;
    if (!trailEnabled && trail && trail.parent) trail.parent.remove(trail);
  }

  function setDebugSurfaces(on) {
    surfaceGain = on ? SURFACE_DEBUG_GAIN : 1;
  }

  function dispose() {
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    if (trail && trail.parent) trail.parent.remove(trail);
    geos.length = 0; mats.length = 0;
  }

  return { group, update, setTrail, setDebugSurfaces, dispose };
}
