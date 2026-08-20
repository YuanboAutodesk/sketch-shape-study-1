// Just enough 4x4 matrix / vector maths for one orbiting camera.
//
// Written out rather than pulled from a library because this machine has no network access,
// so the study app carries ZERO npm dependencies -- it has to run from a bare checkout with
// nothing but the Node that is already installed.
//
// Column-major, the layout WebGL expects (uniformMatrix4fv with transpose = false).

export function identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}

export function multiply(a, b) {
  const o = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3]
    }
  }
  return o
}

export function perspective(fovyDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovyDeg * Math.PI) / 180 / 2)
  const nf = 1 / (near - far)
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ])
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

export function lookAt(eye, target, up) {
  const z = normalize(sub(eye, target))
  let x = cross(up, z)
  if (Math.hypot(x[0], x[1], x[2]) < 1e-6) x = cross([0, 0, 1], z) // eye directly overhead
  x = normalize(x)
  const y = cross(z, x)
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ])
}

/** Translation only -- the study never rotates or scales a model, it only re-centres it. */
export function translation(t) {
  const m = identity()
  m[12] = t[0]
  m[13] = t[1]
  m[14] = t[2]
  return m
}
