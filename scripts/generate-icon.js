// Sinh biểu tượng 128x128 PNG chuẩn RGBA không cần thư viện ngoài (trademark-safe)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 128;
const H = 128;
const raw = Buffer.alloc(H * (1 + W * 4));

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function roundedRectAlpha(x, y, rx, ry, rw, rh, radius) {
  const cx = Math.max(rx + radius, Math.min(rx + rw - radius, x));
  const cy = Math.max(ry + radius, Math.min(ry + rh - radius, y));
  const dist = Math.hypot(x - cx, y - cy) - radius;
  return clamp01(0.5 - dist);
}

function blend(dst, r, g, b, a) {
  const sa = a * (dst[3] / 255);
  const outA = a + dst[3] / 255 * (1 - a);
  if (outA <= 0) return [0, 0, 0, 0];
  return [
    Math.round((r * a + dst[0] * (dst[3] / 255) * (1 - a)) / outA),
    Math.round((g * a + dst[1] * (dst[3] / 255) * (1 - a)) / outA),
    Math.round((b * a + dst[2] * (dst[3] / 255) * (1 - a)) / outA),
    Math.round(outA * 255)
  ];
}

for (let y = 0; y < H; y++) {
  const rowStart = y * (1 + W * 4);
  raw[rowStart] = 0; // PNG filter None
  for (let x = 0; x < W; x++) {
    let px = [0, 0, 0, 0];

    // 1. Nền thẻ bo góc chuyển sắc xanh đen hiện đại
    const bgA = roundedRectAlpha(x + 0.5, y + 0.5, 6, 6, 116, 116, 26);
    if (bgA > 0) {
      const t = (x + y) / (W + H);
      const r = Math.round(18 + 14 * t);
      const g = Math.round(24 + 18 * t);
      const b = Math.round(38 + 28 * t);
      px = blend(px, r, g, b, bgA);
    }

    // Viền mảnh sáng nhẹ
    const outerBorder = roundedRectAlpha(x + 0.5, y + 0.5, 6, 6, 116, 116, 26);
    const innerBorder = roundedRectAlpha(x + 0.5, y + 0.5, 8.5, 8.5, 111, 111, 23.5);
    const borderA = clamp01(outerBorder - innerBorder) * 0.28;
    if (borderA > 0) px = blend(px, 148, 163, 184, borderA);

    // 2. Đường nhịp xung (pulse) phía trên (y ~ 34)
    const pulsePts = [
      [26, 36],
      [46, 36],
      [55, 20],
      [66, 48],
      [75, 29],
      [83, 36],
      [102, 36]
    ];
    let minSegDist = 999;
    for (let i = 0; i < pulsePts.length - 1; i++) {
      const [x1, y1] = pulsePts[i];
      const [x2, y2] = pulsePts[i + 1];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const t = clamp01(((x + 0.5 - x1) * dx + (y + 0.5 - y1) * dy) / (dx * dx + dy * dy));
      const d = Math.hypot(x + 0.5 - (x1 + t * dx), y + 0.5 - (y1 + t * dy));
      if (d < minSegDist) minSegDist = d;
    }
    const pulseA = clamp01(2.6 - minSegDist);
    if (pulseA > 0) px = blend(px, 56, 189, 248, pulseA);

    // 3. Thanh hạn mức 1 (5 giờ — màu ngọc lục bảo, đạt ~42%)
    const bar1Track = roundedRectAlpha(x + 0.5, y + 0.5, 22, 64, 84, 14, 7);
    if (bar1Track > 0) px = blend(px, 51, 65, 85, bar1Track);
    const bar1Fill = roundedRectAlpha(x + 0.5, y + 0.5, 22, 64, 42, 14, 7);
    if (bar1Fill > 0) px = blend(px, 16, 185, 129, bar1Fill);

    // 4. Thanh hạn mức 2 (Tuần — màu hổ phách ấm, đạt ~68%)
    const bar2Track = roundedRectAlpha(x + 0.5, y + 0.5, 22, 88, 84, 14, 7);
    if (bar2Track > 0) px = blend(px, 51, 65, 85, bar2Track);
    const bar2Fill = roundedRectAlpha(x + 0.5, y + 0.5, 22, 88, 60, 14, 7);
    if (bar2Fill > 0) px = blend(px, 245, 158, 11, bar2Fill);

    const idx = rowStart + 1 + x * 4;
    raw[idx] = px[0];
    raw[idx + 1] = px[1];
    raw[idx + 2] = px[2];
    raw[idx + 3] = px[3];
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const idat = zlib.deflateSync(raw, { level: 9 });
const out = Buffer.concat([
  sig,
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', idat),
  pngChunk('IEND', Buffer.alloc(0))
]);

const outPath = path.join(__dirname, '..', 'images', 'icon.png');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out);
console.log('Generated icon:', outPath, out.length, 'bytes');

