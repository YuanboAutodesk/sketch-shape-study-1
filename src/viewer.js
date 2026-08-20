// A shape viewer: components.json + per-part STLs -> an orbitable 3D view, in raw WebGL.
//
// The two viewers in a trial MUST be visually interchangeable, or the study measures
// presentation instead of geometry. Both are built by the same constructor, so they share
// their lighting rig, material response, background and field of view; and each shape is
// framed by ITS OWN bounding sphere, so neither side wins by happening to be modelled at a
// larger scale. The only things that differ are the geometry and the per-part colours that
// ship with it in components.json.

import { perspective, lookAt, multiply, translation } from './mat4.js'
import { loadSTL } from './stl.js'

const VERT = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
uniform mat4 uMVP;
uniform mat4 uModel;
out vec3 vNormal;
void main() {
  vNormal = mat3(uModel) * aNormal;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`

// Two directional lights plus a hemisphere term: enough shaping to read a silhouette and a
// chamfer, with no shadows or specular tricks that could flatter one shape over the other.
const FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
uniform vec3 uColor;
out vec4 outColor;
// +Z is up (CAD convention, which the camera also orbits in)
const vec3 KEY_DIR  = normalize(vec3( 0.55,  0.45,  0.75));
const vec3 FILL_DIR = normalize(vec3(-0.60, -0.35,  0.30));
void main() {
  vec3 n = normalize(vNormal);
  float key  = max(dot(n, KEY_DIR), 0.0) * 0.78;
  float fill = max(dot(n, FILL_DIR), 0.0) * 0.22;
  float hemi = (n.z * 0.5 + 0.5) * 0.28 + 0.22;      // sky above, bounce below
  vec3 c = uColor * (key + fill + hemi);
  c = pow(c, vec3(1.0 / 2.2));                        // linear -> sRGB
  outColor = vec4(c, 1.0);
}`

function compile(gl, type, src) {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s))
  }
  return s
}

export class ShapeViewer {
  constructor(container) {
    this.container = container
    this.canvas = document.createElement('canvas')
    container.appendChild(this.canvas)

    const gl = this.canvas.getContext('webgl2', { antialias: true })
    if (!gl) throw new Error('WebGL2 is required for this study UI')
    this.gl = gl
    gl.enable(gl.DEPTH_TEST)
    gl.clearColor(0.957, 0.961, 0.969, 1)

    const prog = gl.createProgram()
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(prog))
    }
    this.prog = prog
    this.loc = {
      aPos: gl.getAttribLocation(prog, 'aPos'),
      aNormal: gl.getAttribLocation(prog, 'aNormal'),
      uMVP: gl.getUniformLocation(prog, 'uMVP'),
      uModel: gl.getUniformLocation(prog, 'uModel'),
      uColor: gl.getUniformLocation(prog, 'uColor'),
    }

    this.parts = []          // {vao, count, color}
    this.centre = [0, 0, 0]
    this.radius = 1

    // orbit state (azimuth / elevation / distance-in-radii)
    this.az = 0.72
    this.el = 0.42
    this.zoom = 1
    this.onChange = null

    this._bindInput()
    this._onResize = () => this.resize()
    addEventListener('resize', this._onResize)
    this.resize()
    this._tick()
  }

  _bindInput() {
    const c = this.canvas
    let dragging = false
    let lx = 0
    let ly = 0
    c.addEventListener('pointerdown', (e) => {
      dragging = true
      lx = e.clientX
      ly = e.clientY
      c.setPointerCapture(e.pointerId)
    })
    c.addEventListener('pointermove', (e) => {
      if (!dragging) return
      this.az -= (e.clientX - lx) * 0.01
      this.el += (e.clientY - ly) * 0.01
      // stop just short of the poles: at exactly +/-90 the up vector is undefined
      this.el = Math.max(-1.45, Math.min(1.45, this.el))
      lx = e.clientX
      ly = e.clientY
      this.onChange?.(this)
    })
    const stop = (e) => {
      dragging = false
      if (c.hasPointerCapture?.(e.pointerId)) c.releasePointerCapture(e.pointerId)
    }
    c.addEventListener('pointerup', stop)
    c.addEventListener('pointercancel', stop)
    c.addEventListener('wheel', (e) => {
      e.preventDefault()
      this.zoom = Math.max(0.35, Math.min(4, this.zoom * Math.exp(e.deltaY * 0.0012)))
      this.onChange?.(this)
    }, { passive: false })
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const w = Math.max(1, this.container.clientWidth)
    const h = Math.max(1, this.container.clientHeight)
    this.canvas.style.width = w + 'px'
    this.canvas.style.height = h + 'px'
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.aspect = w / h
  }

  clear() {
    const gl = this.gl
    for (const p of this.parts) {
      gl.deleteVertexArray(p.vao)
      p.buffers.forEach((b) => gl.deleteBuffer(b))
    }
    this.parts = []
  }

  /** Load one shape directory: components.json plus the STL each component names. */
  async load(base) {
    const gl = this.gl
    const comps = await (await fetch(`${base}/components.json`)).json()
    const list = comps.components || []

    const loaded = await Promise.all(list.map(async (c) => ({
      geo: await loadSTL(`${base}/${c.stl}`),
      color: (c.color || [180, 180, 180]).map((v) => Math.pow(v / 255, 2.2)), // sRGB -> linear
    })))

    this.clear()

    // bounds over the whole assembly, so the parts keep their relative placement
    let lo = [Infinity, Infinity, Infinity]
    let hi = [-Infinity, -Infinity, -Infinity]
    for (const { geo } of loaded) {
      const p = geo.positions
      for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (p[i + k] < lo[k]) lo[k] = p[i + k]
          if (p[i + k] > hi[k]) hi[k] = p[i + k]
        }
      }
    }
    this.centre = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
    this.radius = Math.max(1e-6, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2)

    for (const { geo, color } of loaded) {
      const vao = gl.createVertexArray()
      gl.bindVertexArray(vao)
      const pb = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, pb)
      gl.bufferData(gl.ARRAY_BUFFER, geo.positions, gl.STATIC_DRAW)
      gl.enableVertexAttribArray(this.loc.aPos)
      gl.vertexAttribPointer(this.loc.aPos, 3, gl.FLOAT, false, 0, 0)
      const nb = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, nb)
      gl.bufferData(gl.ARRAY_BUFFER, geo.normals, gl.STATIC_DRAW)
      gl.enableVertexAttribArray(this.loc.aNormal)
      gl.vertexAttribPointer(this.loc.aNormal, 3, gl.FLOAT, false, 0, 0)
      gl.bindVertexArray(null)
      this.parts.push({ vao, count: geo.positions.length / 3, color, buffers: [pb, nb] })
    }
    return list.length
  }

  resetView() {
    this.az = 0.72
    this.el = 0.42
    this.zoom = 1
    this.onChange?.(this)
  }

  /** Copy another viewer's orbit, so a linked pair is compared at the same angle. */
  syncFrom(other) {
    this.az = other.az
    this.el = other.el
    this.zoom = other.zoom
  }

  _tick = () => {
    this._raf = requestAnimationFrame(this._tick)
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    if (!this.parts.length) return

    // CAD is Z-up; the camera orbits in that frame and the view matrix takes +Z as up.
    const r = this.radius
    const fov = 32
    const dist = (r / Math.sin((fov * Math.PI) / 180 / 2)) * 1.05 * this.zoom
    const ce = Math.cos(this.el)
    const eye = [
      Math.cos(this.az) * ce * dist,
      Math.sin(this.az) * ce * dist,
      Math.sin(this.el) * dist,
    ]
    const proj = perspective(fov, this.aspect, Math.max(dist - r * 3, r * 0.01), dist + r * 4)
    const view = lookAt(eye, [0, 0, 0], [0, 0, 1])
    const model = translation([-this.centre[0], -this.centre[1], -this.centre[2]])
    const mvp = multiply(proj, multiply(view, model))

    gl.useProgram(this.prog)
    gl.uniformMatrix4fv(this.loc.uMVP, false, mvp)
    gl.uniformMatrix4fv(this.loc.uModel, false, model)
    for (const p of this.parts) {
      gl.uniform3f(this.loc.uColor, p.color[0], p.color[1], p.color[2])
      gl.bindVertexArray(p.vao)
      gl.drawArrays(gl.TRIANGLES, 0, p.count)
    }
    gl.bindVertexArray(null)
  }

  dispose() {
    cancelAnimationFrame(this._raf)
    removeEventListener('resize', this._onResize)
    this.clear()
    this.canvas.remove()
  }
}
