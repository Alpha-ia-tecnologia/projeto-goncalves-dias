// Minimal binary FBX reader: enough to pull animation curves out of a Mixamo
// export. Mesh payloads are skipped by name, so a 40 MB "With Skin" file costs
// about as much to read as the 200 KB skeleton-only one would.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const SKIP_ARRAYS = new Set(["Vertices", "PolygonVertexIndex", "Normals", "UV", "UVIndex",
  "Edges", "Weights", "Indexes", "Transform", "TransformLink", "Colors", "ColorIndex",
  "NormalsW", "NormalsIndex", "BinormalsW", "Binormals", "Tangents", "TangentsW", "Smoothing"]);

export function readFbx(path) {
  const data = readFileSync(path);
  const magic = data.toString("binary", 0, 20);
  if (!magic.startsWith("Kaydara FBX Binary")) throw new Error("not a binary FBX: " + path);
  const version = data.readUInt32LE(23);
  const wide = version >= 7500;                       // 7500+ uses 64-bit offsets
  let at = 27;
  const readOffset = () => { const v = wide ? Number(data.readBigUInt64LE(at)) : data.readUInt32LE(at); at += wide ? 8 : 4; return v; };

  function readProperty(keep) {
    const code = String.fromCharCode(data[at++]);
    switch (code) {
      case "Y": { const v = data.readInt16LE(at); at += 2; return v; }
      case "C": return data[at++] !== 0;
      case "I": { const v = data.readInt32LE(at); at += 4; return v; }
      case "F": { const v = data.readFloatLE(at); at += 4; return v; }
      case "D": { const v = data.readDoubleLE(at); at += 8; return v; }
      case "L": { const v = Number(data.readBigInt64LE(at)); at += 8; return v; }
      case "S": case "R": {
        const length = data.readUInt32LE(at); at += 4;
        const value = code === "S" ? data.toString("binary", at, at + length) : length;
        at += length; return value;
      }
      case "f": case "d": case "l": case "i": case "b": {
        const count = data.readUInt32LE(at), encoding = data.readUInt32LE(at + 4), bytes = data.readUInt32LE(at + 8);
        at += 12;
        const start = at; at += bytes;
        if (!keep) return { array: code, length: count };
        const raw = encoding === 1 ? inflateSync(data.subarray(start, start + bytes)) : data.subarray(start, start + bytes);
        const out = new Array(count);
        for (let index = 0; index < count; index++) {
          if (code === "f") out[index] = raw.readFloatLE(index * 4);
          else if (code === "d") out[index] = raw.readDoubleLE(index * 8);
          else if (code === "l") out[index] = Number(raw.readBigInt64LE(index * 8));
          else if (code === "i") out[index] = raw.readInt32LE(index * 4);
          else out[index] = raw[index] !== 0;
        }
        return out;
      }
      default: throw new Error("unknown FBX property type '" + code + "' at " + (at - 1));
    }
  }

  function readNode() {
    const end = readOffset(), propertyCount = readOffset();
    readOffset();                                     // property list length, implied by the walk
    const nameLength = data[at++];
    const name = data.toString("binary", at, at + nameLength); at += nameLength;
    if (end === 0) return null;                       // the null record that closes a list
    const keep = !SKIP_ARRAYS.has(name);
    const properties = [];
    for (let index = 0; index < propertyCount; index++) properties.push(readProperty(keep));
    const children = [];
    while (at < end) { const child = readNode(); if (child) children.push(child); }
    at = end;
    return { name, properties, children };
  }

  const root = { name: "", properties: [], children: [] };
  while (at < data.length - (wide ? 25 : 13)) { const node = readNode(); if (!node) break; root.children.push(node); }
  return { version, root };
}

export const child = (node, name) => node.children.find(candidate => candidate.name === name);
export const childrenNamed = (node, name) => node.children.filter(candidate => candidate.name === name);
