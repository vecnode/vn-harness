#!/usr/bin/env node
/*
    Generates the desktop shell's icons FROM the pack's own source artwork.

        node scripts/make-desktop-icon.mjs

    Writes (and OVERWRITES, so the icons are reproducible from the SVG):

        app/src-tauri/icons/icon.ico   Windows: the .exe resource, and with it
                                       the title bar and taskbar icon
        app/src-tauri/icons/icon.png   512px, for the bundle formats that want
                                       a PNG later (macOS/Linux)

    Why a generator instead of a checked-in drawing: assets/vn-harness.svg is
    the mark's source of truth (a disc centred in a 24px box with a hairline
    transparent margin), so the geometry is READ out of that file - cx, cy, r
    and the viewBox - rather than restated here. Change the asset, re-run this,
    and the icon follows; the two cannot drift into two different marks.

    Why no image library: nothing here is installed to draw a circle. The PNG
    encoder below is the whole of it (IHDR/IDAT/IEND, filter 0, one zlib
    stream) and the ICO is the standard directory of PNG payloads, which every
    Windows since Vista reads.

    The file is written ASCII-only, like every other script in this repository.
*/
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));   // scripts/
const repoRoot = join(here, '..');
const svgPath = join(repoRoot, 'assets', 'vn-harness.svg');
const outDir = join(repoRoot, 'app', 'src-tauri', 'icons');

// ---------------------------------------------------------------------------
// The geometry, read from the asset
// ---------------------------------------------------------------------------
const svg = readFileSync(svgPath, 'utf8');

function numberAttribute(name) {
    const match = new RegExp('\\b' + name + '\\s*=\\s*"([^"]+)"').exec(svg);
    if (!match) throw new Error(svgPath + ' has no ' + name + ' attribute');
    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value)) throw new Error(svgPath + ' has a non-numeric ' + name + ': ' + match[1]);
    return value;
}

const viewBox = (() => {
    const match = /\bviewBox\s*=\s*"([^"]+)"/.exec(svg);
    if (!match) throw new Error(svgPath + ' has no viewBox attribute');
    const parts = match[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error(svgPath + ' has a viewBox this script cannot read: ' + match[1]);
    }
    if (parts[2] !== parts[3]) throw new Error(svgPath + ' is not square; the icon generator assumes a square viewBox');
    return { width: parts[2], height: parts[3] };
})();

const centreX = numberAttribute('cx');
const centreY = numberAttribute('cy');
const radius = numberAttribute('r');

// ---------------------------------------------------------------------------
// Drawing: one disc, antialiased at the edge, over transparency
// ---------------------------------------------------------------------------
function render(size) {
    const pixels = new Uint8Array(size * size * 4);
    const scale = size / viewBox.width;
    const cx = centreX * scale;
    const cy = centreY * scale;
    const r = radius * scale;
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const dx = x + 0.5 - cx;
            const dy = y + 0.5 - cy;
            const distance = Math.sqrt(dx * dx + dy * dy);
            // A one pixel feather: inside the disc is solid, outside is clear,
            // and the ring between is a coverage fraction.
            const coverage = Math.max(0, Math.min(1, r + 0.5 - distance));
            const at = (y * size + x) * 4;
            pixels[at] = 0x00;          // the mark is black, as the asset is
            pixels[at + 1] = 0x00;
            pixels[at + 2] = 0x00;
            pixels[at + 3] = Math.round(coverage * 255);
        }
    }
    return pixels;
}

// ---------------------------------------------------------------------------
// PNG (8-bit RGBA, filter 0)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
    const stride = size * 4;
    const raw = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y += 1) {
        raw[y * (stride + 1)] = 0;                                              // filter: none
        Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride)
            .copy(raw, y * (stride + 1) + 1);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;      // bit depth
    header[9] = 6;      // colour type: truecolour with alpha
    header[10] = 0;     // compression
    header[11] = 0;     // filter
    header[12] = 0;     // interlace
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ---------------------------------------------------------------------------
// ICO: the standard directory of PNG payloads
// ---------------------------------------------------------------------------
const ICO_SIZES = [16, 20, 24, 32, 48, 64, 128, 256];
const PNG_SIZE = 512;

function encodeIco(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);                 // reserved
    header.writeUInt16LE(1, 2);                 // type: icon
    header.writeUInt16LE(images.length, 4);

    let offset = 6 + images.length * 16;
    const entries = images.map((image) => {
        const entry = Buffer.alloc(16);
        const dimension = image.size >= 256 ? 0 : image.size;   // 0 means 256
        entry[0] = dimension;                   // width
        entry[1] = dimension;                   // height
        entry[2] = 0;                           // palette colours
        entry[3] = 0;                           // reserved
        entry.writeUInt16LE(1, 4);              // colour planes
        entry.writeUInt16LE(32, 6);             // bits per pixel
        entry.writeUInt32LE(image.data.length, 8);
        entry.writeUInt32LE(offset, 12);
        offset += image.data.length;
        return entry;
    });

    return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });

const images = ICO_SIZES.map((size) => ({ size, data: encodePng(size, render(size)) }));
const icoPath = join(outDir, 'icon.ico');
const pngPath = join(outDir, 'icon.png');
writeFileSync(icoPath, encodeIco(images));
writeFileSync(pngPath, encodePng(PNG_SIZE, render(PNG_SIZE)));

const show = (path) => relative(repoRoot, path).replace(/\\/g, '/');
console.log('mark read from ' + show(svgPath) + ': centre (' + centreX + ', ' + centreY +
    ') radius ' + radius + ' in a ' + viewBox.width + 'px box');
console.log('wrote ' + show(icoPath) + ' (' + ICO_SIZES.join(', ') + 'px)');
console.log('wrote ' + show(pngPath) + ' (' + PNG_SIZE + 'px)');
