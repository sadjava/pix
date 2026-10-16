import type { PaletteColor, ProjectDocument } from '../model/types.ts';

export interface ExportOptions {
  grid: boolean;
  checker: boolean;
  pixelsPerCell: number;
  border: boolean;
  checkerBlock: number;
}

const CHECK_A: Rgba = [232, 226, 216, 255];
const CHECK_B: Rgba = [196, 188, 176, 255];
const GRID: Rgba = [42, 34, 28, 255];
const BORDER: Rgba = [58, 46, 40, 255];

type Rgba = [number, number, number, number];

export function renderRgba(doc: ProjectDocument, options: ExportOptions): {
  width: number;
  height: number;
  data: Uint8Array;
} {
  const ppc = Math.max(1, Math.round(options.pixelsPerCell));
  const border = options.border ? 4 : 0;
  const width = doc.width * ppc + border * 2;
  const height = doc.height * ppc + border * 2;
  const data = new Uint8Array(width * height * 4);
  if (border) fillRect(data, width, 0, 0, width, height, BORDER);
  for (let y = 0; y < doc.height; y++) {
    for (let x = 0; x < doc.width; x++) {
      const slot = doc.cells[y * doc.width + x] ?? 0;
      const color = slot === 0 ? emptyColor(x, y, options) : hexRgba(doc.palette[slot - 1]);
      fillRect(data, width, border + x * ppc, border + y * ppc, ppc, ppc, color);
    }
  }
  if (options.grid && ppc >= 1) {
    for (let y = 0; y <= doc.height; y++) {
      const py = border + (y === doc.height ? doc.height * ppc - 1 : y * ppc);
      hLine(data, width, border, py, doc.width * ppc, GRID);
    }
    for (let x = 0; x <= doc.width; x++) {
      const px = border + (x === doc.width ? doc.width * ppc - 1 : x * ppc);
      vLine(data, width, height, px, border, doc.height * ppc, GRID);
    }
  }
  return { width, height, data };
}

function emptyColor(x: number, y: number, options: ExportOptions): Rgba {
  if (!options.checker) return [0, 0, 0, 0];
  const block = Math.max(1, options.checkerBlock);
  const dark = (Math.floor(x / block) + Math.floor(y / block)) % 2 === 0;
  return dark ? CHECK_A : CHECK_B;
}

function hexRgba(color: PaletteColor | undefined): Rgba {
  const hex = color?.hex ?? '#000000';
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
    255,
  ];
}

function fillRect(data: Uint8Array, width: number, x: number, y: number, w: number, h: number, color: Rgba): void {
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) setPixel(data, width, x + xx, y + yy, color);
  }
}

function hLine(data: Uint8Array, width: number, x: number, y: number, length: number, color: Rgba): void {
  for (let i = 0; i < length; i++) setPixel(data, width, x + i, y, color);
}

function vLine(data: Uint8Array, imageWidth: number, imageHeight: number, x: number, y: number, length: number, color: Rgba): void {
  for (let i = 0; i < length; i++) {
    if (y + i >= imageHeight) break;
    setPixel(data, imageWidth, x, y + i, color);
  }
}

function setPixel(data: Uint8Array, width: number, x: number, y: number, color: Rgba): void {
  const height = data.length / 4 / width;
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const index = (y * width + x) * 4;
  data[index] = color[0];
  data[index + 1] = color[1];
  data[index + 2] = color[2];
  data[index + 3] = color[3];
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), row + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', zlibStore(raw)), chunk('IEND', new Uint8Array())];
  const size = signature.length + chunks.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  out.set(signature, 0);
  let offset = signature.length;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function zlibStore(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [];
  let stored = 0;
  for (let offset = 0; offset < data.length || (data.length === 0 && stored === 0); offset += 65535) {
    const slice = data.subarray(offset, Math.min(data.length, offset + 65535));
    const last = offset + slice.length >= data.length;
    const header = new Uint8Array(5 + slice.length);
    header[0] = last ? 1 : 0;
    header[1] = slice.length & 255;
    header[2] = slice.length >> 8;
    const nlen = (~slice.length) & 0xffff;
    header[3] = nlen & 255;
    header[4] = nlen >> 8;
    header.set(slice, 5);
    blocks.push(header);
    stored += 1;
    if (data.length === 0) break;
  }
  const adler = adler32(data);
  const body = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(2 + body + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let offset = 2;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  const view = new DataView(out.buffer);
  view.setUint32(out.length - 4, adler);
  return out;
}

function crc32(data: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] ?? 0;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return ~crc >>> 0;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + (data[i] ?? 0)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function pngBytes(doc: ProjectDocument, options: ExportOptions): Uint8Array {
  const image = renderRgba(doc, options);
  return encodePng(image.width, image.height, image.data);
}
