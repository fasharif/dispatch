import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

type Rgb = [number, number, number];

/**
 * A drawn stand-in for the parcel photo a driver would take: a cardboard box with tape on a
 * doorstep, as a real PNG. The demo has no camera; this keeps the console's proof panel legible.
 */
export function demoParcelPhoto(width = 320, height = 240): Buffer {
  const pixel = (x: number, y: number): Rgb => {
    const floor = y > height * 0.72;
    const box = x > width * 0.28 && x < width * 0.72 && y > height * 0.3 && y < height * 0.78;
    const lid = box && y < height * 0.4;
    const tape = box && Math.abs(x - width / 2) < width * 0.03;
    const shadow = !box && floor && x > width * 0.25 && x < width * 0.8 && y < height * 0.82;
    if (tape) return [214, 196, 150];
    if (lid) return [176, 128, 78];
    if (box) return [196, 146, 92];
    if (shadow) return [150, 150, 150];
    if (floor) return [205, 205, 200];
    return [236, 232, 222];
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
