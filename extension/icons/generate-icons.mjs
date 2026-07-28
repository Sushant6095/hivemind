// Generates the Sidekick's honeycomb icons (16/48/128) — no dependencies.
// Draws honey hexagon cells on the dashboard's dark background and encodes a
// valid RGBA PNG via Node's built-in zlib. Run: `node generate-icons.mjs`.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const BG = [14, 15, 19]; // #0e0f13
const HONEY = [245, 184, 61]; // #f5b83d
const HONEY_DIM = [138, 101, 30]; // border tint

// Flat-top hexagon vertices (circumradius r) as a convex polygon.
const hexVerts = (cx, cy, r) =>
  Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 180) * (60 * k);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

// Point inside a convex polygon (consistent winding sign).
function inHex(px, py, verts) {
  let sign = 0;
  for (let i = 0; i < verts.length; i++) {
    const [ax, ay] = verts[i];
    const [bx, by] = verts[(i + 1) % verts.length];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

// Centers of a flat-top honeycomb covering [0,size] with a little bleed.
function hexCenters(size) {
  const r = size / 3.4; // ~3 cells across
  const dx = 1.5 * r;
  const dy = Math.sqrt(3) * r;
  const centers = [];
  let col = 0;
  for (let x = -r; x < size + r; x += dx, col++) {
    const yOff = col % 2 ? dy / 2 : 0;
    for (let y = -r; y < size + r; y += dy) centers.push([x, y + yOff]);
  }
  return { centers, r };
}

function renderPixel(x, y, centers, r) {
  for (const [cx, cy] of centers) {
    if (Math.hypot(x - cx, y - cy) > r) continue; // cheap reject
    if (inHex(x, y, hexVerts(cx, cy, r * 0.9))) return HONEY;
    if (inHex(x, y, hexVerts(cx, cy, r))) return HONEY_DIM; // thin cell border
  }
  return BG;
}

function renderIcon(size) {
  const SS = 3; // supersample for antialiasing
  const { centers, r } = hexCenters(size);
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0, gSum = 0, bSum = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb] = renderPixel(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, centers, r);
          rSum += cr; gSum += cg; bSum += cb;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      px[i] = Math.round(rSum / n);
      px[i + 1] = Math.round(gSum / n);
      px[i + 2] = Math.round(bSum / n);
      px[i + 3] = 255;
    }
  }
  return px;
}

// --- minimal PNG encoder ---------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
};

function encodePng(size, px) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

for (const size of [16, 48, 128]) {
  const out = new URL(`./icon${size}.png`, import.meta.url);
  writeFileSync(out, encodePng(size, renderIcon(size)));
  console.log(`wrote icon${size}.png`);
}
