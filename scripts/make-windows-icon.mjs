import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "build");
const red = [255, 38, 60, 255];
const black = [0, 0, 0, 255];
const white = [255, 255, 255, 255];
const clear = [0, 0, 0, 0];

function roundedRect(pointX, pointY, left, top, right, bottom, radius) {
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const halfWidth = (right - left) / 2;
  const halfHeight = (bottom - top) / 2;
  const distanceX = Math.abs(pointX - centerX) - halfWidth + radius;
  const distanceY = Math.abs(pointY - centerY) - halfHeight + radius;
  return Math.min(Math.max(distanceX, distanceY), 0) + Math.hypot(Math.max(distanceX, 0), Math.max(distanceY, 0)) - radius;
}

function paintSymbol(pointX, pointY) {
  const fromCenterX = pointX - 0.5;
  const fromCenterY = pointY - 0.5;
  if (fromCenterX * fromCenterX + fromCenterY * fromCenterY > 0.46 * 0.46) return clear;
  const leftEye = roundedRect(pointX, pointY, 0.36, 0.3, 0.46, 0.46, 0.025);
  const rightEye = roundedRect(pointX, pointY, 0.54, 0.3, 0.64, 0.46, 0.025);
  if (leftEye <= 0 || rightEye <= 0) return white;
  const body = roundedRect(pointX, pointY, 0.28, 0.2, 0.72, 0.64, 0.14);
  if (body <= 0) return red;
  return black;
}

function rasterize(size) {
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const total = [0, 0, 0, 0];
      for (let sampleY = 0; sampleY < samples; sampleY += 1) {
        for (let sampleX = 0; sampleX < samples; sampleX += 1) {
          const color = paintSymbol(
            (column + (sampleX + 0.5) / samples) / size,
            (row + (sampleY + 0.5) / samples) / size
          );
          total[0] += color[0];
          total[1] += color[1];
          total[2] += color[2];
          total[3] += color[3];
        }
      }
      const offset = (row * size + column) * 4;
      const sampleCount = samples * samples;
      pixels[offset] = Math.round(total[0] / sampleCount);
      pixels[offset + 1] = Math.round(total[1] / sampleCount);
      pixels[offset + 2] = Math.round(total[2] / sampleCount);
      pixels[offset + 3] = Math.round(total[3] / sampleCount);
    }
  }
  return pixels;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function pngFromPixels(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const rawOffset = row * (size * 4 + 1);
    raw[rawOffset] = 0;
    pixels.copy(raw, rawOffset + 1, row * size * 4, (row + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function icoFromPngs(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const directory = Buffer.alloc(16 * pngs.length);
  let imageOffset = header.length + directory.length;
  const images = [];
  pngs.forEach((png, index) => {
    const entry = index * 16;
    directory[entry] = png.size === 256 ? 0 : png.size;
    directory[entry + 1] = png.size === 256 ? 0 : png.size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.bytes.length, entry + 8);
    directory.writeUInt32LE(imageOffset, entry + 12);
    imageOffset += png.bytes.length;
    images.push(png.bytes);
  });
  return Buffer.concat([header, directory, ...images]);
}

fs.mkdirSync(outputDir, { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => {
  const bytes = pngFromPixels(size, rasterize(size));
  if (size === 16 || size === 32 || size === 256) {
    fs.writeFileSync(path.join(outputDir, `icon-${size}.png`), bytes);
  }
  return { size, bytes };
});
fs.writeFileSync(path.join(outputDir, "icon.ico"), icoFromPngs(pngs));
console.log("[gb-notch] Windows icon written to build/icon.ico");
