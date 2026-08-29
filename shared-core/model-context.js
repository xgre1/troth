// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const fs = require('fs');
const os = require('os');

const MAX_SCAN_BYTES = 48 * 1024 * 1024;

const T_UINT8 = 0, T_INT8 = 1, T_UINT16 = 2, T_INT16 = 3, T_UINT32 = 4,
      T_INT32 = 5, T_FLOAT32 = 6, T_BOOL = 7, T_STRING = 8, T_ARRAY = 9,
      T_UINT64 = 10, T_INT64 = 11, T_FLOAT64 = 12;

const FIXED_WIDTH = {
  [T_UINT8]: 1, [T_INT8]: 1, [T_BOOL]: 1,
  [T_UINT16]: 2, [T_INT16]: 2,
  [T_UINT32]: 4, [T_INT32]: 4, [T_FLOAT32]: 4,
  [T_UINT64]: 8, [T_INT64]: 8, [T_FLOAT64]: 8
};

const WANTED = new Set([
  'general.architecture',
  'context_length',
  'block_count',
  'embedding_length',
  'attention.head_count',
  'attention.head_count_kv'
]);

function ggufMetadata(modelPath) {
  let fd = null;
  try {
    const size = fs.statSync(modelPath).size;
    const span = Math.min(size, MAX_SCAN_BYTES);
    const buf = Buffer.alloc(span);
    fd = fs.openSync(modelPath, 'r');
    fs.readSync(fd, buf, 0, span, 0);
    if (buf.length < 24 || buf.toString('latin1', 0, 4) !== 'GGUF') return null;

    let at = 8;                                   // magic + version
    const readU64 = () => { const v = Number(buf.readBigUInt64LE(at)); at += 8; return v; };
    const readU32 = () => { const v = buf.readUInt32LE(at); at += 4; return v; };
    const readStr = () => {
      const n = readU64();
      if (at + n > buf.length) throw new RangeError('past scan window');
      const s = buf.toString('utf8', at, at + n);
      at += n;
      return s;
    };
    const skipValue = (type) => {
      if (FIXED_WIDTH[type]) { at += FIXED_WIDTH[type]; return; }
      if (type === T_STRING) { const n = readU64(); at += n; return; }
      if (type === T_ARRAY) {
        const inner = readU32();
        const count = readU64();
        if (FIXED_WIDTH[inner]) { at += FIXED_WIDTH[inner] * count; return; }
        if (inner === T_STRING) {
          for (let i = 0; i < count; i++) { const n = readU64(); at += n; }
          return;
        }
        throw new RangeError('nested array');     // not emitted by any writer in use
      }
      throw new RangeError('unknown value type ' + type);
    };
    const readScalar = (type) => {
      switch (type) {
        case T_UINT8:  { const v = buf.readUInt8(at);     at += 1; return v; }
        case T_INT8:   { const v = buf.readInt8(at);      at += 1; return v; }
        case T_BOOL:   { const v = !!buf.readUInt8(at);   at += 1; return v; }
        case T_UINT16: { const v = buf.readUInt16LE(at);  at += 2; return v; }
        case T_INT16:  { const v = buf.readInt16LE(at);   at += 2; return v; }
        case T_UINT32: { const v = buf.readUInt32LE(at);  at += 4; return v; }
        case T_INT32:  { const v = buf.readInt32LE(at);   at += 4; return v; }
        case T_FLOAT32:{ const v = buf.readFloatLE(at);   at += 4; return v; }
        case T_UINT64: return readU64();
        case T_INT64:  { const v = Number(buf.readBigInt64LE(at)); at += 8; return v; }
        case T_FLOAT64:{ const v = buf.readDoubleLE(at);  at += 8; return v; }
        case T_STRING: return readStr();
        default: return null;
      }
    };

    at = 8;
    readU64();                                    // tensor count
    const kvCount = readU64();
    const out = {};
    for (let i = 0; i < kvCount; i++) {
      if (at >= buf.length) break;
      const key = readStr();
      const type = readU32();
      const tail = key.indexOf('.') === -1 ? key : key.slice(key.indexOf('.') + 1);
      if (WANTED.has(key) || WANTED.has(tail)) out[key] = readScalar(type);
      else skipValue(type);
    }
    return out;
  } catch (_) {
    return null;                                  // unreadable metadata is not fatal
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

function kvBytesPerToken(meta) {
  const arch = (meta && meta['general.architecture']) || '';
  const g = (suffix) => Number(meta && meta[arch + '.' + suffix]) || 0;
  const layers  = g('block_count');
  const embed   = g('embedding_length');
  const heads   = g('attention.head_count');
  const kvHeads = g('attention.head_count_kv') || heads;
  if (!layers || !embed || !heads || !kvHeads) return 128 * 1024 / 1024;   // ~128KB/1K tok
  const headDim = embed / heads;
  return 2 /* K and V */ * layers * kvHeads * headDim * 2 /* f16 */;
}

function trainedContext(meta) {
  const arch = (meta && meta['general.architecture']) || '';
  return Number(meta && meta[arch + '.context_length']) || 0;
}

const MAX_KV_BYTES  = 8 * 1024 * 1024 * 1024;
const RESERVE_FLOOR = 3 * 1024 * 1024 * 1024;
const RESERVE_SHARE = 0.15;

function kvBudgetBytes(modelBytes, opts) {
  opts = opts || {};
  const total   = Number(opts.total_bytes) || os.totalmem();
  const reserve = Number(opts.reserve_bytes) || Math.max(RESERVE_FLOOR, total * RESERVE_SHARE);
  return Math.max(0, Math.min(total - (Number(modelBytes) || 0) - reserve, MAX_KV_BYTES));
}

function chooseContextSize(modelPath, opts) {
  opts = opts || {};
  const explicit = Number(opts.explicit || 0);
  if (explicit > 0) return { size: explicit, source: 'operator' };

  const meta = ggufMetadata(modelPath);
  const trained = trainedContext(meta);
  const perToken = kvBytesPerToken(meta);
  const floorSize = Number(opts.floor) || 4096;
  if (!trained || !perToken) return { size: floorSize, source: 'fallback' };

  let modelBytes = Number(opts.model_bytes) || 0;
  if (!modelBytes) {
    try { modelBytes = fs.statSync(modelPath).size; } catch (_) { modelBytes = 0; }
  }
  const affordable = Math.floor(kvBudgetBytes(modelBytes, opts) / perToken);

  let size = Math.min(trained, affordable);
  size = Math.floor(size / 1024) * 1024;
  if (size < floorSize) size = floorSize;
  return {
    size,
    source: size >= trained ? 'model' : 'memory',
    trained,
    kv_bytes_per_token: Math.round(perToken)
  };
}

module.exports = { ggufMetadata, trainedContext, kvBytesPerToken, kvBudgetBytes, chooseContextSize };
