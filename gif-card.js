// GIF card container helpers (browser-safe, zero dependencies).
//
// A "GIF card" is a normal animated GIF that carries the character card JSON inside
// a GIF Application Extension block (identifier "STCHARA1"). Every GIF decoder
// ignores unknown application extensions, so the file still plays everywhere.
//
// The format is identical to the one used by the optional server patch, so cards
// exported from here can be read there and vice versa.

const APP_ID = 'STCHARA1'; // 8 bytes
const APP_AUTH = 'UTF'; // 3 bytes

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

const latin1 = (bytes, start, end) => {
    let out = '';
    for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
    return out;
};

/**
 * @param {Uint8Array} bytes
 * @returns {boolean} True if the bytes start with a GIF signature.
 */
export function isGif(bytes) {
    if (!bytes || bytes.length < 13) return false;
    const sig = latin1(bytes, 0, 6);
    return sig === 'GIF87a' || sig === 'GIF89a';
}

/**
 * Walks through the blocks of a GIF.
 * @param {Uint8Array} bytes
 * @returns {{ type: 'ext'|'image'|'trailer', label?: number, appId?: string, start: number, end: number }[]}
 */
function parseBlocks(bytes) {
    if (!isGif(bytes)) throw new Error('Not a GIF file.');

    const blocks = [];
    const packed = bytes[10];
    let pos = 13;
    if (packed & 0x80) pos += 3 * (1 << ((packed & 0x07) + 1));

    const skipSubBlocks = (p) => {
        while (true) {
            if (p >= bytes.length) throw new Error('Corrupted GIF (unexpected end).');
            const len = bytes[p];
            p += 1 + len;
            if (len === 0) return p;
        }
    };

    while (pos < bytes.length) {
        const marker = bytes[pos];

        if (marker === 0x3B) {
            blocks.push({ type: 'trailer', start: pos, end: pos + 1 });
            return blocks;
        }

        if (marker === 0x21) {
            const label = bytes[pos + 1];
            let appId;
            if (label === 0xFF && bytes[pos + 2] === 11) {
                appId = latin1(bytes, pos + 3, pos + 11);
            }
            const end = skipSubBlocks(pos + 2);
            blocks.push({ type: 'ext', label, appId, start: pos, end });
            pos = end;
            continue;
        }

        if (marker === 0x2C) {
            const imgPacked = bytes[pos + 9];
            let p = pos + 10;
            if (imgPacked & 0x80) p += 3 * (1 << ((imgPacked & 0x07) + 1));
            p += 1; // LZW minimum code size
            const end = skipSubBlocks(p);
            blocks.push({ type: 'image', start: pos, end });
            pos = end;
            continue;
        }

        throw new Error(`Corrupted GIF (unknown block 0x${marker.toString(16)} at ${pos}).`);
    }

    return blocks;
}

/**
 * Reads the character card JSON stored in a GIF.
 * @param {Uint8Array} bytes GIF bytes
 * @returns {string|null} Card JSON, or null if the GIF carries no card data
 */
export function readGifCard(bytes) {
    const blocks = parseBlocks(bytes);
    const block = blocks.find(b => b.type === 'ext' && b.appId === APP_ID);
    if (!block) return null;

    // Layout: 0x21 0xFF 0x0B <8 id> <3 auth> <sub-blocks...> 0x00
    let p = block.start + 14;
    const parts = [];
    let total = 0;
    while (p < block.end) {
        const len = bytes[p];
        if (len === 0) break;
        parts.push(bytes.subarray(p + 1, p + 1 + len));
        total += len;
        p += 1 + len;
    }

    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        joined.set(part, offset);
        offset += part.length;
    }
    return decoder.decode(joined);
}

/**
 * Writes character card JSON into a GIF, replacing any previous card data.
 * @param {Uint8Array} bytes GIF bytes
 * @param {string} data Card JSON string
 * @returns {Uint8Array} New GIF bytes
 */
export function writeGifCard(bytes, data) {
    const blocks = parseBlocks(bytes);

    // Insert after the palette and any leading looping extensions (NETSCAPE2.0)
    let insertAt = blocks.length ? blocks[0].start : 13;
    for (const block of blocks) {
        const isLoopExt = block.type === 'ext' && block.appId && /^(NETSCAPE|ANIMEXTS)/.test(block.appId);
        if (isLoopExt) insertAt = block.end;
        else break;
    }

    // Build the extension block
    const payload = encoder.encode(data);
    const subBlockCount = Math.ceil(payload.length / 255);
    const extension = new Uint8Array(3 + 11 + payload.length + subBlockCount + 1);
    extension.set([0x21, 0xFF, 0x0B], 0);
    extension.set(encoder.encode(APP_ID + APP_AUTH), 3);
    let w = 14;
    for (let i = 0; i < payload.length; i += 255) {
        const slice = payload.subarray(i, i + 255);
        extension[w++] = slice.length;
        extension.set(slice, w);
        w += slice.length;
    }
    extension[w++] = 0x00;

    // Copy everything except the old card blocks, inserting the new one
    const removed = blocks.filter(b => b.type === 'ext' && b.appId === APP_ID);
    const pieces = [];
    let cursor = 0;

    const emitUntil = (limit) => {
        for (const r of removed) {
            if (r.start >= cursor && r.start < limit) {
                pieces.push(bytes.subarray(cursor, r.start));
                cursor = r.end;
            }
        }
        pieces.push(bytes.subarray(cursor, limit));
        cursor = limit;
    };

    emitUntil(insertAt);
    pieces.push(extension);
    emitUntil(bytes.length);

    const size = pieces.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const piece of pieces) {
        out.set(piece, offset);
        offset += piece.length;
    }
    return out;
}

/**
 * Renders the first frame of a GIF as a PNG, cover-cropped to a portrait avatar.
 * Browser only.
 * @param {Blob} gifBlob
 * @param {number} [width=512]
 * @param {number} [height=768]
 * @returns {Promise<Blob>} PNG blob
 */
export async function firstFrameToPng(gifBlob, width = 512, height = 768) {
    const bitmap = await createImageBitmap(gifBlob);
    try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(width / bitmap.width, height / bitmap.height);
        const w = bitmap.width * scale;
        const h = bitmap.height * scale;
        ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
        return await new Promise((resolve, reject) => {
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not render the first frame.')), 'image/png');
        });
    } finally {
        bitmap.close?.();
    }
}

/**
 * Converts bytes to base64 without blowing the call stack on big files.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}
