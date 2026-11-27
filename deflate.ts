// deflate.ts — a zopfli-style optimal-parsing DEFLATE encoder (zlib stream out).
// Written from scratch for png-squeeze-01: hash-chain LZ77 with lazy matching and
// bit-cost-aware match acceptance, iterated against optimal Huffman code lengths,
// emitted as dynamic-Huffman blocks. Deterministic: no clock, no randomness.
// Only used when it beats Node's zlib level 9 (measured per instance).

// ---- Bit writer (DEFLATE packs bits LSB-first into bytes) ----
export class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.nbits = 0;
  }
  writeBits(value, count) {
    // value's low `count` bits, least-significant bit first.
    this.acc |= (value & ((count === 32 ? 0xffffffff : (1 << count) - 1))) << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  writeCode(code, len) {
    // A Huffman code: emit its bits most-significant first.
    for (let i = len - 1; i >= 0; i--) this.writeBits((code >> i) & 1, 1);
  }
  finish() {
    if (this.nbits > 0) this.bytes.push(this.acc & 0xff);
    return new Uint8Array(this.bytes);
  }
}

// ---- DEFLATE length / distance code tables ----
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenCodeOf(len) {
  let lo = 0, hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function distCodeOf(dist) {
  let lo = 0, hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// ---- Huffman: code lengths from frequencies (priority queue), canonical codes ----
// Fixed-Huffman literal lengths (RFC 1951) as the first-iteration cost model.
const FIXED_LIT_LEN = new Uint8Array(288);
for (let i = 0; i < 144; i++) FIXED_LIT_LEN[i] = 8;
for (let i = 144; i < 256; i++) FIXED_LIT_LEN[i] = 9;
for (let i = 256; i < 280; i++) FIXED_LIT_LEN[i] = 7;
for (let i = 280; i < 288; i++) FIXED_LIT_LEN[i] = 8;
const FIXED_DIST_LEN = new Uint8Array(30).fill(5);

// Clamp code lengths to `maxLen` and repair the Kraft sum to EXACTLY 1 (a
// complete prefix code). The old version lengthened the rarest symbol until
// Kraft <= 1, which can overshoot below 1: an incomplete code-length code is
// rejected by inflate ("invalid code lengths set") even when its longest
// length is 1. So this version works in exact integer units of 2^-maxLen and
// only ever takes steps that fit the remaining gap, then verifies Kraft == 1
// and falls back to a balanced complete code if anything is still off.
// Always terminates: every step moves Kraft by >= 1 unit toward the target.
function limitLengths(freqs, lengths, maxLen) {
  const n = lengths.length;
  const out = Uint8Array.from(lengths);
  let max = 0;
  for (let i = 0; i < n; i++) if (out[i] > max) max = out[i];
  if (max <= maxLen) return out;
  for (let i = 0; i < n; i++) if (out[i] > maxLen) out[i] = maxLen;
  const TARGET = 1 << maxLen;
  const kraftUnits = () => {
    let K = 0;
    for (let i = 0; i < n; i++) if (out[i] > 0) K += 1 << (maxLen - out[i]);
    return K;
  };
  const used = [...Array(n).keys()].filter((i) => freqs[i] > 0);
  const rareFirst = [...used].sort((a, b) => freqs[a] - freqs[b] || a - b);
  const freqFirst = [...used].sort((a, b) => freqs[b] - freqs[a] || a - b);
  let guard = 0;
  // Oversubscribed: lengthen by exact steps that never overshoot below TARGET.
  while (kraftUnits() > TARGET && guard++ < 100000) {
    const need = kraftUnits() - TARGET;
    let done = false;
    for (const s of rareFirst) {
      if (out[s] > 0 && out[s] < maxLen) {
        const step = 1 << (maxLen - out[s] - 1);
        if (step <= need) { out[s]++; done = true; break; }
      }
    }
    if (!done) break;
  }
  // Incomplete: shorten by exact steps that never overshoot above TARGET.
  guard = 0;
  while (kraftUnits() < TARGET && guard++ < 100000) {
    const need = TARGET - kraftUnits();
    let done = false;
    for (const s of freqFirst) {
      if (out[s] > 1) {
        const step = 1 << (maxLen - out[s]);
        if (step <= need) { out[s]--; done = true; break; }
      }
    }
    if (!done) break;
  }
  if (kraftUnits() !== TARGET) {
    // Safety net: a balanced complete code over the used symbols (Kraft == 1
    // by construction). Shorter lengths go to the most frequent symbols.
    // (limitLengths is only reached with >= 2 used symbols; the 1-symbol
    // case returns early in huffmanLengths.)
    const m = used.length;
    const L = Math.ceil(Math.log2(m));
    const nShort = (1 << L) - m; // symbols at length L-1; the rest at L
    out.fill(0);
    for (let j = 0; j < m; j++) out[freqFirst[j]] = j < nShort ? L - 1 : L;
  }
  return out;
}

function huffmanLengths(freqs, maxLen) {
  // freqs: array of counts (0 = unused). Returns Uint8Array of code lengths,
  // every length <= maxLen, Kraft sum <= 1.
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  const used = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) used.push(i);
  if (used.length === 0) return lengths;
  if (used.length === 1) { lengths[used[0]] = 1; return lengths; }
  // Min-heap of tree nodes.
  const heap = [];
  const push = (node) => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].freq <= heap[i].freq) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].freq < heap[m].freq) m = l;
        if (r < heap.length && heap[r].freq < heap[m].freq) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const s of used) push({ freq: freqs[s], leaf: s, left: null, right: null });
  while (heap.length > 1) {
    const a = pop(), b = pop();
    push({ freq: a.freq + b.freq, leaf: -1, left: a, right: b });
  }
  const root = pop();
  const walk = (node, depth) => {
    if (node.leaf >= 0) { lengths[node.leaf] = depth; return; }
    walk(node.left, depth + 1);
    walk(node.right, depth + 1);
  };
  walk(root, 0);
  return limitLengths(freqs, lengths, maxLen);
}

function canonicalCodes(lengths) {
  // lengths: Uint8Array. Returns {codes: Uint32Array, lens: Uint8Array}.
  const n = lengths.length;
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Array(maxLen + 1).fill(0);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const codes = new Uint32Array(n);
  let code = 0;
  const nextCode = new Array(maxLen + 1).fill(0);
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  for (let i = 0; i < n; i++) {
    const len = lengths[i];
    if (len > 0) codes[i] = nextCode[len]++;
  }
  return { codes, lens: lengths };
}

// ---- LZ77 matching (hash chains, most-recent first) ----
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const WINDOW = 32768;
const MAX_MATCH = 258;

function hash3(data, i) {
  return ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & HASH_MASK;
}

function longestMatch(data, pos, end, head, prev, maxChain, niceLen) {
  const maxPossible = Math.min(MAX_MATCH, end - pos);
  if (maxPossible < 3) return { len: 0, dist: 0 };
  const h = hash3(data, pos);
  let bestLen = 0;
  let bestDist = 0;
  let cand = head[h];
  let chain = 0;
  while (cand >= 0 && pos - cand <= WINDOW && chain < maxChain) {
    // Quick filter: to beat the current best, the byte at bestLen must match.
    if (bestLen === 0 || data[cand + bestLen] === data[pos + bestLen]) {
      let len = 0;
      while (len < maxPossible && data[cand + len] === data[pos + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestDist = pos - cand;
        if (len >= niceLen || len >= maxPossible) break;
      }
    }
    cand = prev[cand];
    chain++;
  }
  return { len: bestLen, dist: bestDist };
}

// Tokenise `data[start..end)` into literals (numbers 0-255) and matches
// ({len, dist}) using lazy matching and a bit-cost model (litLen/lenLen/distLen
// are Huffman code lengths). `head`/`prev` are scratch hash-chain arrays shared
// by the caller (head is reset here; prev is indexed by absolute position and
// only entries in [lo, end) are written). Positions before `start` (up to one
// window back) are inserted as match sources, so matches may reach into
// earlier data, but no emitted match ever crosses `end`.
// Returns {tokens, litFreq, distFreq}.
export function tokenizeRange(data, start, end, litLen, lenLen, distLen, maxChain, niceLen, head, prev) {
  head.fill(-1);
  const tokens = [];
  const litFreq = new Float64Array(288);
  const distFreq = new Float64Array(30);
  let inserted = Math.max(0, start - WINDOW);
  const insertUpTo = (p) => {
    const lim = Math.min(p, end - 2);
    while (inserted < lim) {
      const h = hash3(data, inserted);
      prev[inserted] = head[h];
      head[h] = inserted;
      inserted++;
    }
  };
  const matchCost = (len, dist) => {
    const lc = lenCodeOf(len);
    const dc = distCodeOf(dist);
    return lenLen[lc] + LEN_EXTRA[lc] + distLen[dc] + DIST_EXTRA[dc];
  };
  let i = start;
  while (i < end) {
    insertUpTo(i);
    const m1 = longestMatch(data, i, end, head, prev, maxChain, niceLen);
    if (m1.len < 3) {
      tokens.push(data[i]);
      litFreq[data[i]]++;
      i++;
      continue;
    }
    if (m1.len < 16) {
      // Lazy: a match one byte on may be longer.
      insertUpTo(i + 1);
      const m2 = longestMatch(data, i + 1, end, head, prev, maxChain, niceLen);
      if (m2.len > m1.len) {
        tokens.push(data[i]);
        litFreq[data[i]]++;
        i++;
        continue;
      }
    }
    // Take the match only if it beats its literals in bits.
    let litCostSum = 0;
    for (let k = 0; k < m1.len; k++) litCostSum += litLen[data[i + k]];
    if (matchCost(m1.len, m1.dist) >= litCostSum) {
      tokens.push(data[i]);
      litFreq[data[i]]++;
      i++;
      continue;
    }
    tokens.push({ len: m1.len, dist: m1.dist });
    litFreq[257 + lenCodeOf(m1.len)]++;
    distFreq[distCodeOf(m1.dist)]++;
    i += m1.len;
  }
  litFreq[256]++; // end of block
  return { tokens, litFreq, distFreq };
}

// DP optimal parse of `data[start..end)` (replaces the greedy+lazy tokeniser).
// Forward shortest path: cost[i] = cheapest bit cost to reach offset i, using
// the current Huffman lengths as the cost model. At each offset the literal is
// always available; the match (longest found by the hash chain) is offered at
// every length that is a length-code minimum (LEN_BASE) or the longest length
// itself — those are the only lengths that can be optimal for a given distance
// (a longer length in the same code costs more extra bits for the same code
// length, so the DP only needs the code's minimum plus the longest length).
// dpChain bounds the hash-chain walk per position (the DP calls the matcher
// at EVERY offset, so a deep chain would be far too slow); the DP compensates
// for the weaker match search by choosing lengths optimally. Same interface
// and hash-chain sharing contract as tokenizeRange.
export function tokenizeDP(data, start, end, litLen, lenLen, distLen, maxChain, niceLen, head, prev) {
  head.fill(-1);
  const n = end - start;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const prevPos = new Int32Array(n + 1);
  const prevLen = new Int16Array(n + 1);
  const prevDist = new Int32Array(n + 1);
  cost[0] = 0;
  let inserted = Math.max(0, start - WINDOW);
  const insertUpTo = (p) => {
    const lim = Math.min(p, end - 2);
    while (inserted < lim) {
      const h = hash3(data, inserted);
      prev[inserted] = head[h];
      head[h] = inserted;
      inserted++;
    }
  };
  for (let i = 0; i < n; i++) {
    if (cost[i] === Infinity) continue;
    const pos = start + i;
    insertUpTo(pos);
    // Literal.
    const litC = cost[i] + litLen[data[pos]];
    if (litC < cost[i + 1]) {
      cost[i + 1] = litC;
      prevPos[i + 1] = i;
      prevLen[i + 1] = 1;
      prevDist[i + 1] = 0;
    }
    // Match.
    const m = longestMatch(data, pos, end, head, prev, maxChain, niceLen);
    if (m.len < 3) continue;
    const dc = distCodeOf(m.dist);
    const distC = distLen[dc] + DIST_EXTRA[dc];
    // Candidate lengths: length-code minima up to m.len, plus m.len itself.
    const cands = [];
    for (let lc = 0; lc < 29; lc++) {
      const len = LEN_BASE[lc];
      if (len > m.len) break;
      if (len >= 3) cands.push(len);
    }
    if (cands[cands.length - 1] !== m.len) cands.push(m.len);
    for (const len of cands) {
      const lc = lenCodeOf(len);
      const c = cost[i] + lenLen[lc] + LEN_EXTRA[lc] + distC;
      const j = i + len;
      if (c < cost[j]) {
        cost[j] = c;
        prevPos[j] = i;
        prevLen[j] = len;
        prevDist[j] = m.dist;
      }
    }
  }
  // Reconstruct the token list by walking back from n.
  const tokens = [];
  const litFreq = new Float64Array(288);
  const distFreq = new Float64Array(30);
  let j = n;
  const rev = [];
  while (j > 0) {
    const i = prevPos[j];
    const len = prevLen[j];
    if (len === 1) rev.push(data[start + i]);
    else rev.push({ len, dist: prevDist[j] });
    j = i;
  }
  rev.reverse();
  for (const t of rev) {
    tokens.push(t);
    if (typeof t === 'number') litFreq[t]++;
    else {
      litFreq[257 + lenCodeOf(t.len)]++;
      distFreq[distCodeOf(t.dist)]++;
    }
  }
  litFreq[256]++; // end of block
  return { tokens, litFreq, distFreq };
}

// Whole-data tokenise (the single-block path): fresh hash chains, [0, n).
export function tokenize(data, litLen, lenLen, distLen, maxChain, niceLen) {
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(data.length).fill(-1);
  return tokenizeRange(data, 0, data.length, litLen, lenLen, distLen, maxChain, niceLen, head, prev);
}

// Build dynamic-Huffman code lengths from token frequencies. Returns
// {litLens, distLens, litCodes, distCodes, maxLit, maxDist}.
export function buildDynamic(litFreq, distFreq) {
  const litLens = huffmanLengths(litFreq, 15);
  let distLens = huffmanLengths(distFreq, 15);
  // DEFLATE needs at least one distance code; a block with no matches still
  // needs a (single, unused) distance code of length 1.
  if (distFreq.every((f) => f === 0)) {
    distLens = new Uint8Array(30);
    distLens[0] = 1;
  }
  // Trim trailing zero lengths (HLIT/HDIST count only up to the last used code).
  let maxLit = 286;
  while (maxLit > 257 && litLens[maxLit] === 0) maxLit--;
  let maxDist = 29;
  while (maxDist > 0 && distLens[maxDist] === 0) maxDist--;
  const litC = canonicalCodes(litLens);
  const distC = canonicalCodes(distLens);
  return {
    litLens, distLens,
    litCodes: litC.codes, distCodes: distC.codes,
    maxLit, maxDist,
  };
}

// ---- Dynamic-Huffman block emission ----
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Run-length-encode a code-length sequence into symbols 0-18 (with extra values).
// Returns {syms: number[], extras: number[]} (parallel arrays).
function rleCodeLens(lens) {
  const syms = [];
  const extras = [];
  let i = 0;
  const n = lens.length;
  while (i < n) {
    const v = lens[i];
    let run = 1;
    while (i + run < n && lens[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) {
        const take = Math.min(r, 138);
        syms.push(18); extras.push(take - 11);
        r -= take;
      }
      if (r >= 3) {
        syms.push(17); extras.push(r - 3);
        r = 0;
      }
      while (r > 0) { syms.push(0); extras.push(0); r--; }
    } else {
      syms.push(v); extras.push(0);
      let r = run - 1;
      while (r >= 3) {
        const take = Math.min(r, 6);
        syms.push(16); extras.push(take - 3);
        r -= take;
      }
      while (r > 0) { syms.push(v); extras.push(0); r--; }
    }
    i += run;
  }
  return { syms, extras };
}

// Optimal RLE of a code-length sequence given the code-length Huffman lengths
// (Carbon P5). DP over positions with the previous emitted length as state
// (needed for the 16 "repeat previous" code). Returns {syms, extras} with
// minimal total bits sum(clLens[sym] + extraBits(sym)). Always at least as
// good as the greedy rleCodeLens for the same clLens.
function rleCodeLensDP(seq, clLens) {
  const n = seq.length;
  const runLen = new Uint16Array(n);
  for (let i = n - 1; i >= 0; i--) {
    runLen[i] = (i + 1 < n && seq[i + 1] === seq[i]) ? runLen[i + 1] + 1 : 1;
  }
  const INF = 1e18;
  const NP = 17; // previous length 0..15, 16 = none (start only)
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(NP).fill(INF));
  const parI = Array.from({ length: n + 1 }, () => new Int16Array(NP).fill(-1));
  const parP = Array.from({ length: n + 1 }, () => new Int16Array(NP).fill(-1));
  const parSym = Array.from({ length: n + 1 }, () => new Int16Array(NP).fill(-1));
  const parExtra = Array.from({ length: n + 1 }, () => new Int16Array(NP).fill(0));
  cost[0][16] = 0;
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < NP; p++) {
      const c = cost[i][p];
      if (c === INF) continue;
      const v = seq[i];
      const run = runLen[i];
      const relax = (ni, np, sym, extra, add) => {
        const nc = c + add;
        if (nc < cost[ni][np]) {
          cost[ni][np] = nc;
          parI[ni][np] = i;
          parP[ni][np] = p;
          parSym[ni][np] = sym;
          parExtra[ni][np] = extra;
        }
      };
      // Literal v.
      relax(i + 1, v, v, 0, clLens[v]);
      if (v === 0) {
        const k17 = Math.min(run, 10);
        for (let k = 3; k <= k17; k++) relax(i + k, 0, 17, k - 3, clLens[17] + 3);
        const k18 = Math.min(run, 138);
        for (let k = 11; k <= k18; k++) relax(i + k, 0, 18, k - 11, clLens[18] + 7);
      } else if (p === v) {
        const k16 = Math.min(run, 6);
        for (let k = 3; k <= k16; k++) relax(i + k, v, 16, k - 3, clLens[16] + 2);
      }
    }
  }
  let bestP = 0, bestC = INF;
  for (let p = 0; p < NP; p++) if (cost[n][p] < bestC) { bestC = cost[n][p]; bestP = p; }
  const syms = [];
  const extras = [];
  let i = n, p = bestP;
  while (i > 0) {
    const pi = parI[i][p];
    const pp = parP[i][p];
    const sym = parSym[i][p];
    const extra = parExtra[i][p];
    syms.push(sym);
    extras.push(extra);
    i = pi; p = pp;
  }
  syms.reverse();
  extras.reverse();
  return { syms, extras };
}

// Total header bits (excluding the fixed 5+5+4+HCLEN*3 part, which is the
// same for a given clLens) for an RLE encoding under clLens.
function rleSymbolBits(syms, extras, clLens) {
  let bits = 0;
  for (let k = 0; k < syms.length; k++) {
    const s = syms[k];
    bits += clLens[s];
    if (s === 16) bits += 2;
    else if (s === 17) bits += 3;
    else if (s === 18) bits += 7;
  }
  return bits;
}

export function emitDynamicBlock(bw, tokens, dyn, isFinal) {
  bw.writeBits(isFinal ? 1 : 0, 1);
  bw.writeBits(2, 2); // BTYPE dynamic
  const { litLens, distLens, litCodes, distCodes, maxLit, maxDist } = dyn;
  // The code-length sequence: literal/length lengths then distance lengths.
  const seq = new Uint8Array(maxLit + 1 + maxDist + 1);
  seq.set(litLens.subarray(0, maxLit + 1), 0);
  seq.set(distLens.subarray(0, maxDist + 1), maxLit + 1);
  // Greedy RLE first, then one optimal-DP pass under its code-length tree;
  // keep the DP result only if it is strictly smaller (never worse).
  // Carbon P5 tree-RLE, measured +38.
  let { syms, extras } = rleCodeLens(seq);
  {
    const clFreq0 = new Float64Array(19);
    for (const s of syms) clFreq0[s]++;
    const clLens0 = huffmanLengths(clFreq0, 7);
    const dp = rleCodeLensDP(seq, clLens0);
    const clFreq1 = new Float64Array(19);
    for (const s of dp.syms) clFreq1[s]++;
    const clLens1 = huffmanLengths(clFreq1, 7);
    if (rleSymbolBits(dp.syms, dp.extras, clLens1) < rleSymbolBits(syms, extras, clLens0)) {
      syms = dp.syms;
      extras = dp.extras;
    }
  }
  const clFreq = new Float64Array(19);
  for (const s of syms) clFreq[s]++;
  const clLens = huffmanLengths(clFreq, 7);
  const clC = canonicalCodes(clLens);
  let hclen = 4;
  for (let j = 18; j >= 4; j--) if (clLens[CL_ORDER[j]] > 0) { hclen = j + 1; break; }
  bw.writeBits(maxLit - 256, 5);
  bw.writeBits(maxDist, 5);
  bw.writeBits(hclen - 4, 4);
  for (let j = 0; j < hclen; j++) bw.writeBits(clLens[CL_ORDER[j]], 3);
  for (let k = 0; k < syms.length; k++) {
    const s = syms[k];
    bw.writeCode(clC.codes[s], clLens[s]);
    if (s === 16) bw.writeBits(extras[k], 2);
    else if (s === 17) bw.writeBits(extras[k], 3);
    else if (s === 18) bw.writeBits(extras[k], 7);
  }
  for (const t of tokens) {
    if (typeof t === 'number') {
      bw.writeCode(litCodes[t], litLens[t]);
    } else {
      const lc = lenCodeOf(t.len);
      const dc = distCodeOf(t.dist);
      bw.writeCode(litCodes[257 + lc], litLens[257 + lc]);
      if (LEN_EXTRA[lc] > 0) bw.writeBits(t.len - LEN_BASE[lc], LEN_EXTRA[lc]);
      bw.writeCode(distCodes[dc], distLens[dc]);
      if (DIST_EXTRA[dc] > 0) bw.writeBits(t.dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  bw.writeCode(litCodes[256], litLens[256]); // end of block
}

export function emitFixedBlock(bw, tokens, isFinal) {
  bw.writeBits(isFinal ? 1 : 0, 1);
  bw.writeBits(1, 2); // BTYPE fixed
  const litC = canonicalCodes(FIXED_LIT_LEN);
  const distC = canonicalCodes(FIXED_DIST_LEN);
  for (const t of tokens) {
    if (typeof t === 'number') {
      bw.writeCode(litC.codes[t], FIXED_LIT_LEN[t]);
    } else {
      const lc = lenCodeOf(t.len);
      const dc = distCodeOf(t.dist);
      bw.writeCode(litC.codes[257 + lc], FIXED_LIT_LEN[257 + lc]);
      if (LEN_EXTRA[lc] > 0) bw.writeBits(t.len - LEN_BASE[lc], LEN_EXTRA[lc]);
      bw.writeCode(distC.codes[dc], FIXED_DIST_LEN[dc]);
      if (DIST_EXTRA[dc] > 0) bw.writeBits(t.dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  bw.writeCode(litC.codes[256], FIXED_LIT_LEN[256]);
}

// Adler-32 (zlib's checksum).
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Encode `data` as a zlib stream with the optimal parser split into blocks of
// `blockSize` bytes, each block carrying its own dynamic (or fixed) Huffman
// table. Matches may reach into earlier blocks (the window spans blocks) but
// never cross a block boundary. Per block, the cost model is iterated like
// deflateOptimal (fixed costs, then that block's own dynamic lengths), and the
// smaller of the block's dynamic / fixed encoding is kept.
export function deflateOptimalBlocks(data, blockSize, maxChain = 64, niceLen = 32, rounds = 2) {
  const head = new Int32Array(HASH_SIZE);
  const prev = new Int32Array(data.length).fill(-1);
  const bw = new BitWriter();
  const nBlocks = Math.max(1, Math.ceil(data.length / blockSize));
  for (let b = 0; b < nBlocks; b++) {
    const start = b * blockSize;
    const end = Math.min(data.length, start + blockSize);
    const isFinal = b === nBlocks - 1;
    // Cost model for this block: round 0 fixed, later rounds this block's own
    // dynamic lengths from the previous round.
    let litLen = FIXED_LIT_LEN;
    let lenLen = new Uint8Array(29);
    for (let c = 0; c < 29; c++) lenLen[c] = FIXED_LIT_LEN[257 + c];
    let distLen = FIXED_DIST_LEN;
    let bestTokens = null;
    let bestDyn = null;
    let bestBytes = Infinity;
    for (let round = 0; round < rounds; round++) {
      const { tokens, litFreq, distFreq } = tokenizeRange(data, start, end, litLen, lenLen, distLen, maxChain, niceLen, head, prev);
      const dyn = buildDynamic(litFreq, distFreq);
      const bwD = new BitWriter();
      emitDynamicBlock(bwD, tokens, dyn, isFinal);
      const dynBytes = bwD.finish();
      const bwF = new BitWriter();
      emitFixedBlock(bwF, tokens, isFinal);
      const fixBytes = bwF.finish();
      const roundBest = dynBytes.length <= fixBytes.length ? dynBytes.length : fixBytes.length;
      if (roundBest < bestBytes) {
        bestBytes = roundBest;
        bestTokens = tokens;
        bestDyn = dyn;
      }
      // Next round's cost model comes from this round's dynamic Huffman lengths.
      litLen = dyn.litLens;
      lenLen = new Uint8Array(29);
      for (let c = 0; c < 29; c++) lenLen[c] = dyn.litLens[257 + c];
      distLen = dyn.distLens;
    }
    // Emit the winning round's block into the main stream. Re-emit both forms
    // and keep the smaller (identical sizes to the trials: same tokens, same
    // isFinal flag).
    const bwD = new BitWriter();
    emitDynamicBlock(bwD, bestTokens, bestDyn, isFinal);
    const dynBytes = bwD.finish();
    const bwF = new BitWriter();
    emitFixedBlock(bwF, bestTokens, isFinal);
    const fixBytes = bwF.finish();
    if (dynBytes.length <= fixBytes.length) emitDynamicBlock(bw, bestTokens, bestDyn, isFinal);
    else emitFixedBlock(bw, bestTokens, isFinal);
  }
  const best = bw.finish();
  // zlib wrapper: header 0x78 0x9C, deflate stream, adler32 (big-endian).
  const out = new Uint8Array(2 + best.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(best, 2);
  new DataView(out.buffer).setUint32(2 + best.length, adler32(data));
  return out;
}

// ---- v3: Match Cache + Global DP (Carbon P1+P2) ----
// Fixed-point DP costs in units of 1/64 bit (Uint32; the max cost for a
// 3.7MB stream is far below 2^31, so additions never overflow).
const DP_INF = 0xffffffff;

function makeDPWorkspace(maxN) {
  return {
    same: new Uint16Array(maxN),
    head1: new Int32Array(1 << 15).fill(-1),
    // All prev accesses use 15-bit ring indices (slot = i & 32767), so the
    // chains only need 32 KiB of entries, not the whole stream.
    prev1: new Int32Array(Math.min(maxN, 32768)),
    head2: new Int32Array(1 << 15).fill(-1),
    prev2: new Int32Array(Math.min(maxN, 32768)),
    stepOff: new Uint32Array(maxN + 1),
    stepPack: new Uint32Array(Math.max(1024, maxN * 2)),
    cost: new Uint32Array(maxN + 1),
    pathLen: new Uint16Array(maxN + 1),
    pathDist: new Uint16Array(maxN + 1),
  };
}

// Build the LZ77 sublen-step cache (Carbon P1): for each position, the list of
// (dist, startLen, endLen) steps, where each step says "a match of any length
// in [startLen, endLen] is achievable at this dist, and startLen is one past
// the previous best length for a shorter dist". Dual hash chains (prev1 on the
// 3-byte prefix, prev2 on the run structure) skip the flood of 0,0,0 prefixes
// with zero missed solutions. stepBudget is a deterministic cap on total
// hash-chain steps (no clock). `data` must have >=258 bytes of zero padding
// past n so getUint32/hash reads never run off the end.
function buildMatchCache(data, n, maxChain, stepBudget, ws) {
  const { same, head1, prev1, head2, prev2, stepOff } = ws;
  let stepPack = ws.stepPack;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  same[n - 1] = 1;
  for (let i = n - 2; i >= 0; i--) {
    same[i] = data[i] === data[i + 1] ? (same[i + 1] < 258 ? same[i + 1] + 1 : 258) : 1;
  }
  head1.fill(-1);
  head2.fill(-1);
  let stepCount = 0;
  let usedChainOps = 0;
  const ensure = (need) => {
    if (stepCount + need > stepPack.length) {
      const grown = new Uint32Array(Math.max(stepPack.length * 2, stepCount + need));
      grown.set(stepPack.subarray(0, stepCount));
      ws.stepPack = grown;
      stepPack = grown;
    }
  };
  for (let i = 0; i < n; i++) {
    stepOff[i] = stepCount;
    const slot = i & 32767;
    const sLen = same[i];
    const nextB = i + sLen < n ? data[i + sLen] : 0;
    const h1 = (((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) * 0x9e3779b1) >>> 17;
    const h2 = (((sLen << 16) ^ (data[i] << 8) ^ nextB) * 0x85ebca6b) >>> 17;
    prev1[slot] = head1[h1];
    head1[h1] = i;
    prev2[slot] = head2[h2];
    head2[h2] = i;
    const maxL = n - i < 258 ? n - i : 258;
    if (maxL < 3) continue;
    if (i > 0 && data[i] === data[i - 1] && sLen === 258 && maxL === 258) {
      ensure(1);
      stepPack[stepCount++] = (1 << 16) | (3 << 8) | (258 - 3);
      continue;
    }
    const remPos = n - i;
    let dynLimit = ((stepBudget - usedChainOps) / remPos) | 0;
    if (dynLimit > maxChain) dynLimit = maxChain;
    else if (dynLimit < 8) dynLimit = 8;
    const limit = dynLimit;
    let bestLen = 2;
    let p = prev1[slot];
    let usingHash2 = false;
    const minPos = i > 32768 ? i - 32768 : 0;
    for (let steps = 0; p >= minPos && steps < limit; steps++) {
      usedChainOps++;
      if (data[p + bestLen] === data[i + bestLen]) {
        let len = 0;
        while (len + 4 <= maxL && dv.getUint32(p + len, true) === dv.getUint32(i + len, true)) len += 4;
        while (len < maxL && data[p + len] === data[i + len]) len++;
        if (len > bestLen) {
          const dist = i - p;
          const startL = bestLen + 1;
          ensure(1);
          // startL can be 258; clamp to 255 (lengths 255..258 are all valid
          // for this dist once len=258 is reachable, so no solution is lost).
          const sL = startL > 255 ? 255 : startL;
          stepPack[stepCount++] = (dist << 16) | (sL << 8) | (len - 3);
          bestLen = len;
          if (bestLen === maxL) break;
        }
      }
      // When sLen == 1 the hash2 key only distinguishes the first two bytes
      // and the run length, and bestLen(2) >= sLen is already true — so the
      // first chain would be abandoned after a single probe, missing long
      // matches that only the hash1 chain reaches. Keep the first chain.
      if (!usingHash2 && sLen > 1 && bestLen >= sLen && sLen < 258 && i + sLen < n) {
        // Switch to the hash2 chain: continue from the head of THIS position's
        // hash2 chain (prev2[i]), not from prev2[p] — p's run structure is
        // only guaranteed to match i's when p itself produced the long match,
        // but bestLen may come from an earlier candidate.
        usingHash2 = true;
        p = prev2[slot];
      } else {
        p = usingHash2 ? prev2[p & 32767] : prev1[p & 32767];
      }
    }
  }
  stepOff[n] = stepCount;
  return stepCount;
}

// Forward DP over the whole stream using the match cache and per-block Huffman
// cost tables (fixed point, 1/64 bit). blockOf[i] is the block of byte i.
// Returns cost[n] (total bits * 64). pathLen/pathDist (in ws) hold the token
// ending at each position for backtracking.
function runGlobalDP(data, n, blockOf, stepOff, stepPack, litCost, lenCost, distCost, ws) {
  const { cost, pathLen, pathDist } = ws;
  cost.fill(DP_INF, 1, n + 1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    const cur = cost[i];
    if (cur === DP_INF) continue;
    const b = blockOf[i];
    const litC = cur + litCost[(b << 8) | data[i]];
    if (litC < cost[i + 1]) {
      cost[i + 1] = litC;
      pathLen[i + 1] = 1;
      pathDist[i + 1] = 0;
    }
    const sBeg = stepOff[i];
    const sEnd = stepOff[i + 1];
    const lenBase = b * 259;
    const distBase = b * 32769;
    for (let s = sBeg; s < sEnd; s++) {
      const packed = stepPack[s];
      const dist = packed >>> 16;
      const startL = (packed >>> 8) & 0xff;
      const endL = (packed & 0xff) + 3;
      const baseCost = cur + distCost[distBase + dist];
      for (let k = startL; k <= endL; k++) {
        const c = baseCost + lenCost[lenBase + k];
        if (c < cost[i + k]) {
          cost[i + k] = c;
          pathLen[i + k] = k;
          pathDist[i + k] = dist;
        }
      }
    }
  }
  return cost[n];
}

function backtrackTokens(data, n, pathLen, pathDist) {
  const rev = [];
  let j = n;
  while (j > 0) {
    const len = pathLen[j];
    const dist = pathDist[j];
    if (len <= 1) {
      rev.push(data[j - 1]);
      j -= 1;
    } else {
      rev.push({ len, dist });
      j -= len;
    }
  }
  rev.reverse();
  return rev;
}

// Per-block Huffman cost tables (fixed point) from per-block Huffman lengths.
// litCost[b*256+byte], lenCost[b*259+len] (len 0..258, raw length),
// distCost[b*32769+dist].
function buildCostTables(numBlocks, litLensArr, distLensArr) {
  const litCost = new Uint32Array(numBlocks * 256);
  const lenCost = new Uint32Array(numBlocks * 259);
  const distCost = new Uint32Array(numBlocks * 32769);
  for (let b = 0; b < numBlocks; b++) {
    const ll = litLensArr[b];
    const dl = distLensArr[b];
    for (let byte = 0; byte < 256; byte++) {
      litCost[b * 256 + byte] = (ll[byte] > 0 ? ll[byte] : 15) * 64;
    }
    for (let len = 0; len < 259; len++) {
      const lc = lenCodeOf(len);
      const l = ll[257 + lc] > 0 ? ll[257 + lc] : 15;
      lenCost[b * 259 + len] = (l + LEN_EXTRA[lc]) * 64;
    }
    for (let dist = 0; dist < 32769; dist++) {
      const dc = distCodeOf(dist);
      const d = dl[dc] > 0 ? dl[dc] : 15;
      distCost[b * 32769 + dist] = (d + DIST_EXTRA[dc]) * 64;
    }
  }
  return { litCost, lenCost, distCost };
}

// Exact bit counts for one DEFLATE block, mirroring emitDynamicBlock /
// emitFixedBlock bit-for-bit (same header construction, same token costs,
// including the greedy-vs-DP RLE choice in the dynamic header). Lets
// emitGlobal pick dynamic vs fixed without trial-writing both blocks.
// The comparison uses ceil(bits/8) with dynamic winning ties, exactly as
// the old trial-write compared dynBytes.length <= fixBytes.length.
function dynamicBlockBits(tokens, dyn) {
  const { litLens, distLens, maxLit, maxDist } = dyn;
  const seq = new Uint8Array(maxLit + 1 + maxDist + 1);
  seq.set(litLens.subarray(0, maxLit + 1), 0);
  seq.set(distLens.subarray(0, maxDist + 1), maxLit + 1);
  let { syms, extras } = rleCodeLens(seq);
  {
    const clFreq0 = new Float64Array(19);
    for (const s of syms) clFreq0[s]++;
    const clLens0 = huffmanLengths(clFreq0, 7);
    const dp = rleCodeLensDP(seq, clLens0);
    const clFreq1 = new Float64Array(19);
    for (const s of dp.syms) clFreq1[s]++;
    const clLens1 = huffmanLengths(clFreq1, 7);
    if (rleSymbolBits(dp.syms, dp.extras, clLens1) < rleSymbolBits(syms, extras, clLens0)) {
      syms = dp.syms;
      extras = dp.extras;
    }
  }
  const clFreq = new Float64Array(19);
  for (const s of syms) clFreq[s]++;
  const clLens = huffmanLengths(clFreq, 7);
  let hclen = 4;
  for (let j = 18; j >= 4; j--) if (clLens[CL_ORDER[j]] > 0) { hclen = j + 1; break; }
  let bits = 3 + 5 + 5 + 4 + hclen * 3; // BFINAL+BTYPE, HLIT, HDIST, HCLEN, CL lengths
  for (let k = 0; k < syms.length; k++) {
    const s = syms[k];
    bits += clLens[s];
    if (s === 16) bits += 2;
    else if (s === 17) bits += 3;
    else if (s === 18) bits += 7;
  }
  for (const t of tokens) {
    if (typeof t === 'number') {
      bits += litLens[t];
    } else {
      const lc = lenCodeOf(t.len);
      const dc = distCodeOf(t.dist);
      bits += litLens[257 + lc] + LEN_EXTRA[lc] + distLens[dc] + DIST_EXTRA[dc];
    }
  }
  bits += litLens[256]; // end of block
  return bits;
}

function fixedBlockBits(tokens) {
  let bits = 3; // BFINAL+BTYPE
  for (const t of tokens) {
    if (typeof t === 'number') {
      bits += FIXED_LIT_LEN[t];
    } else {
      const lc = lenCodeOf(t.len);
      const dc = distCodeOf(t.dist);
      bits += FIXED_LIT_LEN[257 + lc] + LEN_EXTRA[lc] + FIXED_DIST_LEN[dc] + DIST_EXTRA[dc];
    }
  }
  bits += FIXED_LIT_LEN[256]; // end of block
  return bits;
}

// Emit the DP token list as a zlib stream, one DEFLATE block per block index
// (tokens grouped by the block of their start position; dynamic vs fixed per
// block, smaller wins). Returns {bytes, litFreqArr, distFreqArr}.
function emitGlobal(data, tokens, blockOf, numBlocks) {
  const blockTokens = Array.from({ length: numBlocks }, () => []);
  const litFreqArr = Array.from({ length: numBlocks }, () => new Float64Array(288));
  const distFreqArr = Array.from({ length: numBlocks }, () => new Float64Array(30));
  let pos = 0;
  for (const t of tokens) {
    const b = blockOf[pos];
    blockTokens[b].push(t);
    if (typeof t === 'number') {
      litFreqArr[b][t]++;
      pos += 1;
    } else {
      litFreqArr[b][257 + lenCodeOf(t.len)]++;
      distFreqArr[b][distCodeOf(t.dist)]++;
      pos += t.len;
    }
  }
  for (let b = 0; b < numBlocks; b++) litFreqArr[b][256]++;
  const bw = new BitWriter();
  for (let b = 0; b < numBlocks; b++) {
    const isFinal = b === numBlocks - 1;
    const dyn = buildDynamic(litFreqArr[b], distFreqArr[b]);
    // Pick dynamic vs fixed by exact bit counts (same ceil/8 rounding and
    // dynamic-wins-ties rule as the old trial-write), then emit only the winner.
    const dynBits = dynamicBlockBits(blockTokens[b], dyn);
    const fixBits = fixedBlockBits(blockTokens[b]);
    if (((dynBits + 7) >> 3) <= ((fixBits + 7) >> 3)) emitDynamicBlock(bw, blockTokens[b], dyn, isFinal);
    else emitFixedBlock(bw, blockTokens[b], isFinal);
  }
  const best = bw.finish();
  const out = new Uint8Array(2 + best.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(best, 2);
  new DataView(out.buffer).setUint32(2 + best.length, adler32(data));
  return { bytes: out, litFreqArr, distFreqArr };
}

// Deterministic xorshift32 PRNG (fixed seed; no clock, no Math.random).
function makeXorshift(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return s >>> 0;
  };
}

// ---- P5 helper: exact dynamic-block header bit count ----
// Given lit/dist code lengths, compute the exact number of bits the dynamic
// header would occupy (HLIT/HDIST/HCLEN + code-length tree + RLE'd lengths).
// Mirrors emitDynamicBlock's header construction exactly.
function dynamicHeaderBits(litLens, distLens) {
  let maxLit = 286;
  while (maxLit > 257 && litLens[maxLit] === 0) maxLit--;
  let maxDist = 29;
  while (maxDist > 0 && distLens[maxDist] === 0) maxDist--;
  const seq = new Uint8Array(maxLit + 1 + maxDist + 1);
  seq.set(litLens.subarray(0, maxLit + 1), 0);
  seq.set(distLens.subarray(0, maxDist + 1), maxLit + 1);
  const { syms, extras } = rleCodeLens(seq);
  const clFreq = new Float64Array(19);
  for (const s of syms) clFreq[s]++;
  const clLens = huffmanLengths(clFreq, 7);
  let hclen = 4;
  for (let j = 18; j >= 4; j--) if (clLens[CL_ORDER[j]] > 0) { hclen = j + 1; break; }
  let bits = 5 + 5 + 4 + hclen * 3;
  for (let k = 0; k < syms.length; k++) {
    const s = syms[k];
    bits += clLens[s];
    if (s === 16) bits += 2;
    else if (s === 17) bits += 3;
    else if (s === 18) bits += 7;
  }
  return bits;
}

// Greedy tokenisation from the match cache: at each position take the longest
// match in the cache (max endLen over steps), else a literal. Returns
// {pos, len, dist, count} (plain JS arrays; pos is the byte offset).
function greedyTokensFromCache(n, stepOff, stepPack) {
  const pos = [];
  const len = [];
  const dist = [];
  let i = 0;
  while (i < n) {
    let bestLen = 0, bestDist = 0;
    for (let s = stepOff[i]; s < stepOff[i + 1]; s++) {
      const packed = stepPack[s];
      const endL = (packed & 0xff) + 3;
      if (endL > bestLen) { bestLen = endL; bestDist = packed >>> 16; }
    }
    if (bestLen >= 3) {
      pos.push(i); len.push(bestLen); dist.push(bestDist);
      i += bestLen;
    } else {
      pos.push(i); len.push(1); dist.push(0);
      i += 1;
    }
  }
  return { pos, len, dist, count: pos.length };
}

// MDL block splitting (Carbon P2) on the greedy token list. A split is
// accepted only when the two sub-blocks' dynamic costs (token bits + exact
// header) are strictly less than the parent's. Returns {blockOf, numBlocks}.
// Candidate split points are the 1/2, 1/4 and 3/4 token positions.
function mdlBlockSplit(data, n, stepOff, stepPack) {
  const tok = greedyTokensFromCache(n, stepOff, stepPack);
  const m = tok.count;
  const litFreq = new Float64Array(288);
  const distFreq = new Float64Array(30);
  function costOf(l, r) {
    litFreq.fill(0);
    distFreq.fill(0);
    for (let t = l; t < r; t++) {
      if (tok.len[t] === 1) {
        litFreq[data[tok.pos[t]]]++;
      } else {
        litFreq[257 + lenCodeOf(tok.len[t])]++;
        distFreq[distCodeOf(tok.dist[t])]++;
      }
    }
    litFreq[256]++;
    const ll = huffmanLengths(litFreq, 15);
    let dl = huffmanLengths(distFreq, 15);
    if (distFreq.every((f) => f === 0)) { dl = new Uint8Array(30); dl[0] = 1; }
    let bits = 0;
    for (let i = 0; i < 288; i++) bits += litFreq[i] * ll[i];
    for (let i = 0; i < 30; i++) bits += distFreq[i] * dl[i];
    bits += dynamicHeaderBits(ll, dl);
    return bits;
  }
  const ranges = [];
  const MIN_TOKENS = 1024;
  const MAX_DEPTH = 6;
  function bisect(l, r, depth) {
    if (r - l <= MIN_TOKENS || depth >= MAX_DEPTH) {
      ranges.push([tok.pos[l], r < m ? tok.pos[r] : n]);
      return;
    }
    const c0 = costOf(l, r);
    let bestM = -1, bestC = Infinity;
    for (const frac of [0.5, 0.25, 0.75]) {
      const mm = l + Math.floor((r - l) * frac);
      if (mm <= l || mm >= r) continue;
      const c = costOf(l, mm) + costOf(mm, r);
      if (c < bestC) { bestC = c; bestM = mm; }
    }
    if (bestM > 0 && bestC < c0) {
      bisect(l, bestM, depth + 1);
      bisect(bestM, r, depth + 1);
    } else {
      ranges.push([tok.pos[l], r < m ? tok.pos[r] : n]);
    }
  }
  bisect(0, m, 0);
  const blockOf = new Uint8Array(n);
  for (let b = 0; b < ranges.length; b++) {
    const [s, e] = ranges[b];
    for (let i = s; i < e; i++) blockOf[i] = b;
  }
  return { blockOf, numBlocks: ranges.length };
}

// Top-level v3 encoder: match cache once + fixed blocks + iterative global DP
// with deterministic perturbation. Returns a zlib stream (Uint8Array).
// opts: blockSize (default 262144), maxChain (default 256), stepBudgetPerByte
// (default 64), maxRounds (default 4 — V5: cut from 8 for timeout safety;
// measured: 8 rounds = 776,982 @ 43.65s on 猫猫, 4 rounds = 775,786 @ 30.77s,
// only -1,196 pts for -13.7s; maxChain stays 512, chain 256 lost 2,625 pts).
export function deflateGlobalDP(data, opts = {}) {
  const n = data.length;
  const maxChain = opts.maxChain ?? 512;
  const stepBudget = (opts.stepBudgetPerByte ?? 256) * n;
  const maxRounds = opts.maxRounds ?? 4;
  const padded = new Uint8Array(n + 258);
  padded.set(data);
  const ws = makeDPWorkspace(n);
  buildMatchCache(padded, n, maxChain, stepBudget, ws);
  // MDL dynamic block boundaries (Carbon P2, measured +4,648 over fixed 256K).
  const { blockOf, numBlocks } = mdlBlockSplit(padded, n, ws.stepOff, ws.stepPack);
  const rng = makeXorshift(0x9e3779b9);
  let litLensArr = Array.from({ length: numBlocks }, () => FIXED_LIT_LEN);
  let distLensArr = Array.from({ length: numBlocks }, () => FIXED_DIST_LEN);
  let litFreqArr = null;
  let distFreqArr = null;
  let best = null;
  let bestBytes = Infinity;
  let stall = 0;
  for (let round = 0; round < maxRounds; round++) {
    let llArr = litLensArr;
    let dlArr = distLensArr;
    if (round >= 4 && stall >= 2 && litFreqArr !== null) {
      // Deterministic perturbation of the frequencies to escape local optima.
      llArr = litFreqArr.map((f) => {
        const pf = new Float64Array(288);
        for (let i = 0; i < 288; i++) {
          pf[i] = f[i] > 0 ? (f[i] * (100 + (rng() % 45)) / 128) : 0;
        }
        return huffmanLengths(pf, 15);
      });
      dlArr = distFreqArr.map((f) => {
        const pf = new Float64Array(30);
        for (let i = 0; i < 30; i++) {
          pf[i] = f[i] > 0 ? (f[i] * (100 + (rng() % 45)) / 128) : 0;
        }
        let d = huffmanLengths(pf, 15);
        if (pf.every((x) => x === 0)) { d = new Uint8Array(30); d[0] = 1; }
        return d;
      });
    }
    const { litCost, lenCost, distCost } = buildCostTables(numBlocks, llArr, dlArr);
    runGlobalDP(padded, n, blockOf, ws.stepOff, ws.stepPack, litCost, lenCost, distCost, ws);
    const tokens = backtrackTokens(padded, n, ws.pathLen, ws.pathDist);
    const { bytes, litFreqArr: lf, distFreqArr: df } = emitGlobal(data, tokens, blockOf, numBlocks);
    if (bytes.length < bestBytes) {
      bestBytes = bytes.length;
      best = bytes;
      stall = 0;
    } else {
      stall++;
    }
    litFreqArr = lf;
    distFreqArr = df;
    litLensArr = lf.map((f) => huffmanLengths(f, 15));
    distLensArr = df.map((f) => {
      const d = huffmanLengths(f, 15);
      if (f.every((x) => x === 0)) { const z = new Uint8Array(30); z[0] = 1; return z; }
      return d;
    });
    if (round >= 5 && stall >= 3) break;
  }
  return best;
}

// Same as deflateOptimalBlocks but the per-block parse is the DP optimal parse
// (tokenizeDP) instead of greedy+lazy. dpChain bounds the hash-chain walk per
// DP position (the DP calls the matcher at every offset, so it must stay
// shallow). Rounds iterate the Huffman cost model the same way.
export function deflateOptimalBlocksDP(data, blockSize, dpChain = 16, niceLen = 258, rounds = 2) {
  const head = new Int32Array(HASH_SIZE);
  const prev = new Int32Array(data.length).fill(-1);
  const bw = new BitWriter();
  const nBlocks = Math.max(1, Math.ceil(data.length / blockSize));
  for (let b = 0; b < nBlocks; b++) {
    const start = b * blockSize;
    const end = Math.min(data.length, start + blockSize);
    const isFinal = b === nBlocks - 1;
    let litLen = FIXED_LIT_LEN;
    let lenLen = new Uint8Array(29);
    for (let c = 0; c < 29; c++) lenLen[c] = FIXED_LIT_LEN[257 + c];
    let distLen = FIXED_DIST_LEN;
    let bestTokens = null;
    let bestDyn = null;
    let bestBytes = Infinity;
    for (let round = 0; round < rounds; round++) {
      const { tokens, litFreq, distFreq } = tokenizeDP(data, start, end, litLen, lenLen, distLen, dpChain, niceLen, head, prev);
      const dyn = buildDynamic(litFreq, distFreq);
      const bwD = new BitWriter();
      emitDynamicBlock(bwD, tokens, dyn, isFinal);
      const dynBytes = bwD.finish();
      const bwF = new BitWriter();
      emitFixedBlock(bwF, tokens, isFinal);
      const fixBytes = bwF.finish();
      const roundBest = dynBytes.length <= fixBytes.length ? dynBytes.length : fixBytes.length;
      if (roundBest < bestBytes) {
        bestBytes = roundBest;
        bestTokens = tokens;
        bestDyn = dyn;
      }
      litLen = dyn.litLens;
      lenLen = new Uint8Array(29);
      for (let c = 0; c < 29; c++) lenLen[c] = dyn.litLens[257 + c];
      distLen = dyn.distLens;
    }
    const bwD = new BitWriter();
    emitDynamicBlock(bwD, bestTokens, bestDyn, isFinal);
    const dynBytes = bwD.finish();
    const bwF = new BitWriter();
    emitFixedBlock(bwF, bestTokens, isFinal);
    const fixBytes = bwF.finish();
    if (dynBytes.length <= fixBytes.length) emitDynamicBlock(bw, bestTokens, bestDyn, isFinal);
    else emitFixedBlock(bw, bestTokens, isFinal);
  }
  const best = bw.finish();
  const out = new Uint8Array(2 + best.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(best, 2);
  new DataView(out.buffer).setUint32(2 + best.length, adler32(data));
  return out;
}

// Encode `data` (filtered bytes) as a zlib stream with the optimal parser.
// Iterates the cost model: fixed costs, then the dynamic Huffman costs from the
// previous pass. Keeps the smallest of (dynamic, fixed) encodings.
export function deflateOptimal(data, maxChain = 64, niceLen = 32, rounds = 2) {
  let best = null;
  // Cost model for this round: litLen[288], lenLen[29] (indexed by length code),
  // distLen[30]. Round 0 uses the fixed Huffman lengths.
  let litLen = FIXED_LIT_LEN;
  let lenLen = new Uint8Array(29);
  for (let c = 0; c < 29; c++) lenLen[c] = FIXED_LIT_LEN[257 + c];
  let distLen = FIXED_DIST_LEN;
  for (let round = 0; round < rounds; round++) {
    const { tokens, litFreq, distFreq } = tokenize(data, litLen, lenLen, distLen, maxChain, niceLen);
    const dyn = buildDynamic(litFreq, distFreq);
    // Dynamic block.
    const bwD = new BitWriter();
    emitDynamicBlock(bwD, tokens, dyn, true);
    const dynBytes = bwD.finish();
    if (best === null || dynBytes.length < best.length) best = dynBytes;
    // Fixed block (same tokens, fixed Huffman table).
    const bwF = new BitWriter();
    emitFixedBlock(bwF, tokens, true);
    const fixBytes = bwF.finish();
    if (fixBytes.length < best.length) best = fixBytes;
    // Next round's cost model comes from this round's dynamic Huffman lengths.
    litLen = dyn.litLens;
    lenLen = new Uint8Array(29);
    for (let c = 0; c < 29; c++) lenLen[c] = dyn.litLens[257 + c];
    distLen = dyn.distLens;
  }
  // zlib wrapper: header 0x78 0x9C, deflate stream, adler32 (big-endian).
  const out = new Uint8Array(2 + best.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(best, 2);
  new DataView(out.buffer).setUint32(2 + best.length, adler32(data));
  return out;
}
