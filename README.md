# PNG Squeeze — 27 November 2026

[![png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/poppychan-cloud/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/poppychan-cloud/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Lossless PNG recompression for the
[png-squeeze-01-run-20261127 bounty](https://make.fun/bounty/png-squeeze-01-run-20261127):
reads 8 stored 1280x720 RGBA screenshots from `/input/<id>/image.png` and
writes each back losslessly to `/output/<id>/image.png`, as small as possible.

Per instance it analyses the pixels (unique colours, grey?, alpha profile),
picks the best colour type (palette type 3 for <=256 colours, grey type 0/4,
RGB type 2, RGBA type 6), screens per-scanline adaptive filters (fixed 0-4,
minsum, pairs, brute force at level 4 with 32 KiB dictionary context, screened
by zlib level 6), then encodes the winner with the smaller of Node's built-in
zlib level 9 and a from-scratch zopfli-style optimal-parse DEFLATE encoder
(`deflate.ts`: hash-chain LZ77, lazy matching, bit-cost model, dynamic Huffman
with code-length RLE). Only IHDR, PLTE (type 3 only), tRNS, IDAT and IEND are
emitted, bit depth 8, non-interlaced, single zlib stream. A transparent
pixel's RGB is never altered. Deterministic: two runs produce identical bytes;
no clock, no randomness, no network. Whole set runs in ~17 s on this machine
(budget 60 s).

## Build

```sh
node main.ts   # reads /input, writes /output (Node 22, no dependencies)
```

`main.ts` is the grader entrypoint. `deflate.ts` is the optimal-parse DEFLATE
encoder it uses. `run-practice.mjs` runs the program on the kit practice set
and prints per-instance bytes + points + total score + runtime.

## License

MIT. See [LICENSE](LICENSE).
