// Canyon Runner — single tuning surface. ORCHESTRATOR-OWNED: agents must not edit.
// Modules read `CFG.<SECTION>?.name ?? localDefault` so missing keys never crash.

export const WORLD = {
  SEED: 20261114,        // deterministic world
  SIZE: 16000,           // meters per side, centered at origin
  PLATEAU_H: 1200,       // nominal plateau elevation (MSL m)
  PLAIN_H: 300,          // lowland beyond world edge
  CANYON: {
    MIN_LEN: 13000,      // main canyon total length (m)
    DEPTH: 350,          // rim-to-floor depth (m)
    WIDTH_MIN: 120,
    WIDTH_MAX: 260,
    SIDE_COUNT_MIN: 5,
    SIDE_COUNT_MAX: 8,
    RIVER_W: 22,         // max water strip width (m)
  },
  MESA_MIN: 15,          // guaranteed mesas/buttes
  WIND: 0,               // reserved; wind vector (m/s), 0 = none
}

export const PHYS = { DT: 1 / 60 }

export const FLIGHT = {
  // geometry & masses (light aerobatic tailwheel-ish)
  MASS: 700,             // kg
  WING_S: 11.0,          // m^2
  RHO: 1.225,
  // polar
  CL0: 0.35, CL_A: 5.2,  // per rad
  CL_MAX: 1.45, ALPHA_STALL: 0.29, // rad (~16.6 deg)
  CD0: 0.028, OSWALD: 0.86,
  // power
  POWER_MAX: 110000,     // W shaft at full throttle
  PROP_T_COEF: 0.9,      // thrust = P/v * coef (capped at T_MAX)
  T_MAX: 2600,           // N static thrust cap
  // handling
  PITCH_RATE: 1.1, ROLL_RATE: 2.6, YAW_RATE: 0.5, // rad/s authority at 1g ref speed
  DAMP_P: 0.9, DAMP_R: 2.2, DAMP_Y: 1.4,          // body rate damping
  STATIC_P: 0.8, STATIC_Y: 1.2,                   // pitch/yaw static stability
  TRIM_RATE: 0.25, TRIM_RANGE: 0.6,               // elevator trim rad-ish offset
  FLAP_CL: 0.45, FLAP_CD: 0.05,                   // per unit flaps
  // accessibility assist
  ASSIST: {
    AUTO_RUDDER: true,        // coordinate turns with aileron
    SPIRAL_STAB: true,        // gentle roll/heading coupling damping
    ALPHA_LIMIT: true,        // soft nose-down nudge before hard stall
    RATE_LIMIT: true,         // stick rate limiting (also in controls)
  },
  // speeds
  TRIM_SPEED: 45,          // m/s level trim baseline
  ROTATE_V: 33,            // m/s liftoff threshold
  VNE: 92,                 // m/s overspeed
  GENTLE_SINK: 2.5,        // m/s max touchdown sink
  GENTLE_ROLL: 25,         // deg
  GENTLE_SPEED: 55,        // m/s max landing speed
  RESPAWN_FREEZE: 1.5,     // s after crash
}

export const CONTROLS = {
  // slew limits per second for ctl channels
  SLEW: { elevator: 4, aileron: 4, rudder: 3, throttle: 0.8, flaps: 0.5, trim: 0.6 },
  TILT_MAX: 22,            // deg of device tilt for full control deflection
  TILT_DEADBAND: 3.5,      // deg around neutral
  TILT_PITCH_BIAS: 0,      // deg neutral pose offset (beta)
  GYRO_SMOOTH: 0.25,       // low-pass factor (0=off, 0.9=very heavy)
  KEY_STEP: { throttle: 0.02, flaps: 0.03 }, // per-frame increments for keys
}

export const RENDER = {
  CHUNK: 256,              // m per terrain chunk
  DRAW_RINGS: 4,           // chunk rings around player
  RES_HI: 96, RES_MID: 48, RES_LO: 24,  // verts per chunk side by LOD ring
  FOG_NEAR: 900, FOG_FAR: 3400,
  SKY_TOP: 0x3a6db8, SKY_HORIZON: 0xbfd3e6, SUN: 0xfff2df,
  WATER_COLOR: 0x2e5f8a, WATER_ALPHA: 0.75,
  CAM_BACK: 14, CAM_UP: 4, CAM_SMOOTH: 0.12,  // chase camera m / factor
}

export const HUD = {
  STALL_ALPHA: 0.24,       // rad warning threshold (< ALPHA_STALL)
  MINIMAP_SIZE: 256,       // css px (raster is 512 internally)
  MINIMAP_RANGE: 3200,     // m half-range shown
  RASTER_SLICE_MS: 4,      // progressive raster budget per frame slice
}
