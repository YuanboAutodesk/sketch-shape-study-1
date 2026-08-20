// STL -> flat vertex/normal arrays, ready for a WebGL buffer.
//
// The pipeline exports one STL per part. Both encodings appear in the tree, so both are
// handled, and the binary case is detected by the size the header CLAIMS rather than by
// sniffing for the word "solid" -- binary STLs are known to start with that word too, which
// is the classic way this goes wrong.
//
// Facet normals are used as-is (flat shading). For CAD tessellation that is the honest
// look: a chamfer should read as a chamfer, not get smoothed into a fillet by averaged
// vertex normals.

export function parseSTL(buffer) {
  const view = new DataView(buffer)
  if (buffer.byteLength > 84) {
    const nTri = view.getUint32(80, true)
    if (84 + nTri * 50 === buffer.byteLength) return parseBinary(view, nTri)
  }
  return parseASCII(new TextDecoder().decode(buffer))
}

function parseBinary(view, nTri) {
  const positions = new Float32Array(nTri * 9)
  const normals = new Float32Array(nTri * 9)
  let o = 84
  for (let i = 0; i < nTri; i++) {
    const nx = view.getFloat32(o, true)
    const ny = view.getFloat32(o + 4, true)
    const nz = view.getFloat32(o + 8, true)
    o += 12
    for (let v = 0; v < 3; v++) {
      const p = i * 9 + v * 3
      positions[p] = view.getFloat32(o, true)
      positions[p + 1] = view.getFloat32(o + 4, true)
      positions[p + 2] = view.getFloat32(o + 8, true)
      normals[p] = nx
      normals[p + 1] = ny
      normals[p + 2] = nz
      o += 12
    }
    o += 2 // attribute byte count
  }
  return { positions, normals, triangles: nTri }
}

function parseASCII(text) {
  const pos = []
  const nrm = []
  let n = [0, 0, 1]
  const re = /facet\s+normal\s+([^\n]*)|vertex\s+([^\n]*)/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) {
      const p = m[1].trim().split(/\s+/).map(Number)
      if (p.length === 3 && p.every(Number.isFinite)) n = p
    } else {
      const p = m[2].trim().split(/\s+/).map(Number)
      if (p.length === 3 && p.every(Number.isFinite)) {
        pos.push(p[0], p[1], p[2])
        nrm.push(n[0], n[1], n[2])
      }
    }
  }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    triangles: pos.length / 9,
  }
}

export async function loadSTL(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return parseSTL(await res.arrayBuffer())
}
