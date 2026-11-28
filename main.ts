// png-squeeze-01 entry (B account): one program that rewrites every screenshot in a set
// losslessly as a PNG in as few bytes as it can. Node 22, built-ins only, deterministic.
// Strategy: analyse each image (unique colours / grey / alpha) -> pick the best colour
// form (palette type 3, grey 0/4, RGB 2, RGBA 6, tRNS key) -> screen every filter choice
// (fixed 0-4, minsum, pairs, brute force) by zlib level 6 -> write the winner with
// zlib level 9. No clock, no randomness, no environment as a source of variation.
import { deflateSync, inflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateGlobalDP, setWasm } from './deflate.ts';

// ---- WASM hot loops (V9) ----
// hot.wasm is base64-embedded below by the build step (embed-wasm.mjs); the
// file fallback is for local dev only (the grader has no hot.wasm on disk).
const WASM_B64 = 'AGFzbQEAAAABLAZgAABgA39/fwF/YAABf2AEf39/fwF/YAV/f39/fwF/YAh/f39/f39/fwF/AxkYAAEBAgICAgICAgICAgICAgMCAgICAQQFBQQBAIAYBkgKfwFBoNiOPgt/AEGACAt/AEGY2Io+C38AQaDYij4LfwBBoNiOPgt/AEGACAt/AEGg2I4+C38AQYCAgOAAC38AQQALfwBBAQsH+AMiBm1lbW9yeQIAEV9fd2FzbV9jYWxsX2N0b3JzAAAGbWVtc2V0AAEGbWVtY3B5AAIIcHRyX2RhdGEAAwhwdHJfc2FtZQAEC3B0cl9zdGVwT2ZmAAUMcHRyX3N0ZXBQYWNrAAYIcHRyX2Nvc3QABwtwdHJfcGF0aExlbgAIDHB0cl9wYXRoRGlzdAAJC3B0cl9ibG9ja09mAAoLcHRyX2xpdENvc3QACwtwdHJfbGVuQ29zdAAMDHB0cl9kaXN0Q29zdAANEnN0ZXBfcGFja19jYXBhY2l0eQAOD3N0ZXBfcGFja19jb3VudAAPEWJ1aWxkX21hdGNoX2NhY2hlABAJcHRyX2hlYWQzABEJcHRyX2hlYWQ0ABIKcHRyX2J0TGVmdAATC3B0cl9idFJpZ2h0ABQVYnQ0X2J1aWxkX21hdGNoX2NhY2hlABUYaHlicmlkX2J1aWxkX21hdGNoX2NhY2hlABYNcnVuX2dsb2JhbF9kcAAXDF9fZHNvX2hhbmRsZQMBCl9fZGF0YV9lbmQDAgtfX3N0YWNrX2xvdwMDDF9fc3RhY2tfaGlnaAMEDV9fZ2xvYmFsX2Jhc2UDBQtfX2hlYXBfYmFzZQMGCl9faGVhcF9lbmQDBw1fX21lbW9yeV9iYXNlAwgMX190YWJsZV9iYXNlAwkK/y8YAgALtQEBA38CQCACRQ0AIAJBB3EhA0EAIQQCQCACQQhJDQAgAkF4cSEFQQAhBANAIAAgBGoiAiABOgAAIAJBB2ogAToAACACQQZqIAE6AAAgAkEFaiABOgAAIAJBBGogAToAACACQQNqIAE6AAAgAkECaiABOgAAIAJBAWogAToAACAFIARBCGoiBEcNAAsLIANFDQAgACAEaiECA0AgAiABOgAAIAJBAWohAiADQX9qIgMNAAsLIAALuAEBBH8CQCACRQ0AIAJBA3EhA0EAIQQCQCACQQRJDQAgAkF8cSEFQQAhBANAIAAgBGoiAiABIARqIgYtAAA6AAAgAkEBaiAGQQFqLQAAOgAAIAJBAmogBkECai0AADoAACACQQNqIAZBA2otAAA6AAAgBSAEQQRqIgRHDQALCyADRQ0AIAEgBGohAiAAIARqIQQDQCAEIAItAAA6AAAgAkEBaiECIARBAWohBCADQX9qIgMNAAsLIAALCABBgIiAgAALCABB4I/hgQALCABBkJ+jhQALCABB4L2njAALCABB4M3ImwALCABBsOzMogALCABB4PuOpgALCABBkIvRqQALCABB8JKyqwALCABB8JK2qwALCABB8Ji6qwALBwBBgKToAwsLAEEAKALwmrqvAAvECQEafyABQQF0Qd6P4YEAakEBOwEAAkAgAUECSA0AIAFBf2oiBEEBcSEFQQEhBgJAIAFBfmoiB0UNACAAQX1qIQggBEF+cSEJIAFBAXRB2o/hgQBqIQcgASEEQQEhBgNAIAdBAmogBkEBakGCAiAGQf//A3FBggJJG0EBIAggBGoiBkEBaiIKLQAAIAZBAmotAABGGyILOwEAIAcgC0EBakGCAiALQf//A3FBggJJG0EBIAYtAAAgCi0AAEYbIgY7AQAgB0F8aiEHIARBfmohBCAJQX5qIgkNAAsgBEF+aiEHCyAFRQ0AIAdBAXRB4I/hgQBqIAZBAWpBggIgBkH//wNxQYICSRtBASAAIAdqLQAAIABBAWogB2otAABGGzsBAAtBgJu6rwBB/wFBgIAIEIGAgIAAIQxBgJvCrwBB/wFBgIAIEIGAgIAAIQ1BACEOAkAgAUEBSA0AIAAhCCABIQ9BACEOQQAhEEEAIREDQCARIhJBAnRBkJ+jhQBqIA42AgBBACEHAkAgEiASQQF0QeCP4YEAai8BACITaiIGIAFOIhQNACAAIAZqLQAAIQcLIBNBEHQgACASaiIVLQAAIgZBCHRyIAdB/wFxckHrlK+veGxBD3ZB/P8HcSANaiIHKAIAIQQgFS0AAiELIAAgEkEBaiIRai0AACEJIAcgEjYCACASQf//AXFBAnQiB0GAm9KvAGoiFiAENgIAIAdBgJvKrwBqIAsgCUEFdCAGQQp0c3NBsfPd8XlsQQ92Qfz/B3EgDGoiBygCACIXNgIAIAcgEjYCAAJAIAEgEmsiB0EDSA0AAkAgEkUNACAHQYICSQ0AIBNBggJHDQAgFS0AAEH/AXEgFUF/ai0AAEH/AXFHDQACQCAOQf+j6ANNDQBBfw8LIA5BAnRB4L2njABqQf+HBDYCACAOQQFqIQ4MAQsgAyAQayAHbSEGIBdBACASQYCAfmoiBCAEIBJLGyIYSA0AIAIgBkEIIAZBCEobIAYgAkobIhlBAUgNACAPQYICIA9BggJIGyEaIAdBggIgB0GCAkgbIQpBAiEFQQAhGyATQYECSyEcQQAhHQNAIBBBAWohEAJAAkAgACAXaiIJIAVqLQAAIBUgBWotAABGDQAgBSEHDAELQQAhBCAIIQsCQANAIAshBiAEIgdBBGoiBCAKSg0BIAZBBGohCyAJIAdqKAAAIAggB2ooAABGDQALCwJAIAcgCk4NAANAIAkgB2otAAAgBi0AAEcNASAGQQFqIQYgGiAHQQFqIgdHDQALIBohBwsCQCAHIAVKDQAgBSEHDAELAkAgDkH/o+gDTQ0AQX8PCyAOQQJ0QeC9p4wAaiASIBdrQRB0IAVB/gEgBUH+AUgbQQh0QYACanIgB0F9anI2AgAgDkEBaiEOIAcgCkYNAgsCQAJAIBNBAkkNACAdDQAgFA0AIBwNAEEBIQQgFiEGIAcgE04NAQsgF0H//wFxQQJ0QYCb0q8AQYCbyq8AIB0baiEGIB0hBAsgBigCACIXIBhIDQEgBCEdIAchBSAbQQFqIhsgGUgNAAsLIAhBAWohCCAPQX9qIQ8gESABRw0ACwtBACAONgLwmrqvACABQQJ0QZCfo4UAaiAONgIAIA4LCABBgJvarwALCABBgJvirwALCABBgJvyrwALCABBgJv6rwAL2gsBFX8gAUEBdEHej+GBAGpBATsBAAJAIAFBAkgNACABQX9qIgNBAXEhBEEBIQUCQCABQX5qIgZFDQAgAEF9aiEHIANBfnEhCCABQQF0QdqP4YEAaiEGIAEhA0EBIQUDQCAGQQJqIAVBAWpBggIgBUH//wNxQYICSRtBASAHIANqIgVBAWoiCS0AACAFQQJqLQAARhsiCjsBACAGIApBAWpBggIgCkH//wNxQYICSRtBASAFLQAAIAktAABGGyIFOwEAIAZBfGohBiADQX5qIQMgCEF+aiIIDQALIANBfmohBgsgBEUNACAGQQF0QeCP4YEAaiAFQQFqQYICIAVB//8DcUGCAkkbQQEgACAGai0AACAAQQFqIAZqLQAARhs7AQALQYCb2q8AQf8BQYCACBCBgICAACELQYCb4q8AQf8BQYCAEBCBgICAACEMQYCb8q8AQf8BQYCACBCBgICAACENQYCb+q8AQf8BQYCACBCBgICAACEOQQAhDwJAIAFBAUgNACAAIQkgASEQQQAhD0EAIREDQCARQQJ0QZCfo4UAaiAPNgIAAkAgASARayIDQQNIDQACQAJAIBENACAALQAAIQoMAQsgACARaiIGLQAAIQogA0GCAkkNACAKQf8BcSAGQX9qLQAAQf8BcUcNACARQQF0QeCP4YEAai8BAEH//wNxQYICRw0AAkAgD0H/o+gDTQ0AQX8PCyAPQQJ0QeC9p4wAakH/hwQ2AgAgD0EBaiEPDAELIBBBggIgEEGCAkgbIRIgACARaiIGLQABIgdBBXQgCkH/AXFBCnRzIAYtAAIiE3NBsfPd8XlsQQ92Qfz/B3EgC2oiBSgCACEIIAYtAAMhFCAFIBE2AgACQAJAIAhBACARQYCAfmoiBiAGIBFLGyIVTg0AQQIhBAwBCyASQQEgEkEBShshBSAAIAhqIQZBACEEAkADQCAGIARqLQAAIAkgBGotAABHDQEgBSAEQQFqIgRHDQALIAUhBAsCQCAEQQNPDQBBAiEEDAELAkAgD0H/o+gDTQ0AQX8PCyAPQQJ0QeC9p4wAaiARIAhrQRB0IARBfWpyQYAGcjYCACAPQQFqIQ8LQQAhBUF+IRYCQAJAIAdBEHQgCkEYdHIgE0EIdHIgFHJBsfPd8XlsQRB2QQJ0IAxqIhcoAgAiBkEATg0AIAYhAwwBCwJAIAJBAU4NACAGIQMMAQsgA0GCAiADQYICSBshB0EAIRQCQANAIAAgBiIWaiEIIAkhCkEAIQMCQANAIAohBSADIgZBBGoiAyAHSg0BIAVBBGohCiAIIAZqKAAAIAkgBmooAABGDQALC0EAIRMCQCAGIAdODQACQANAIAggBmotAAAiAyAFLQAAIgpHDQEgBUEBaiEFIBIgBkEBaiIGRw0ACyAHIQYMAQsgAyAKayETCwJAIBYgFUgNACAGIARMDQACQCAPQf+j6ANNDQBBfw8LIA9BAnRB4L2njABqIBEgFmtBEHQgBEH+ASAEQf4BSRtBCHRBgAJqciAGQX1qcjYCACAPQQFqIQ8gBiAHRg0CIAYhBAsgFkH//wFxIQYCQAJAIBNBf0oNAEF/IQMgBkECdCANaigCACIGQX9KDQFBASEFDAQLQQAhBSAGQQJ0IA5qKAIAIgZBAE4NAEF/IQMMAwsgFEEBaiIUIAJIDQALQQAhBSAGIQNBfiEWDAELQQAhBUF+IQMLIBFB//8BcSEGAkAgA0F/Sg0AIBZBfkcNACAXIBE2AgAgBkECdCIGIA5qQX82AgAgBiANakF/NgIADAELIBZBAEgNACAWQQJ0Qfz/B3EiCiANaiIIIAogDmoiByAFGygCACEKIAZBAnQiBiANakF/NgIAIAYgDmogCkF/IANBfkYbNgIAAkAgBUUNACAIIBE2AgAMAQsgByARNgIACyAJQQFqIQkgEEF/aiEQIBFBAWoiESABRw0ACwtBACAPNgLwmrqvACABQQJ0QZCfo4UAaiAPNgIAIA8L1g8HD38DfgJ/AX4GfwF+B38gAUEBdEHej+GBAGpBATsBAAJAIAFBAkgNACABQX9qIgVBAXEhBkEBIQcCQCABQX5qIghFDQAgAEF9aiEJIAVBfnEhCiABQQF0QdqP4YEAaiEIIAEhBUEBIQcDQCAIQQJqIAdBAWpBggIgB0H//wNxQYICSRtBASAJIAVqIgdBAWoiCy0AACAHQQJqLQAARhsiDDsBACAIIAxBAWpBggIgDEH//wNxQYICSRtBASAHLQAAIAstAABGGyIHOwEAIAhBfGohCCAFQX5qIQUgCkF+aiIKDQALIAVBfmohCAsgBkUNACAIQQF0QeCP4YEAaiAHQQFqQYICIAdB//8DcUGCAkkbQQEgACAIai0AACAAQQFqIAhqLQAARhs7AQALQYCbuq8AQf8BQYCACBCBgICAACENQYCbwq8AQf8BQYCACBCBgICAACEOQYCb4q8AQf8BQYCAEBCBgICAACEPQQAhEAJAIAFBAEwNAEGAm4KwAEH/ASABQQJ0IggQgYCAgAAhEUHQuYa3AEH/ASAIEIGAgIAAIRIgAEEBaiETIAGtIRQgA60hFUIAIRYgACEGIAEhF0EAIRBBACEYA0AgFiIZpyIaQQJ0IhtBkJ+jhQBqIBA2AgAgGkH//wFxIQdBACEIAkAgGiAaQQF0QeCP4YEAai8BACIcaiIFIAFOIh0NACAAIAVqLQAAIQgLIBxBEHQgACAaaiIeLQAAIgVBCHRyIAhB/wFxckHrlK+veGxBD3ZB/P8HcSAOaiIIKAIAIQwgHi0AAiEKIAAgGUIBfCIWp2otAAAhCyAIIBo2AgAgB0ECdCIIQYCb0q8AaiIfIAw2AgAgCEGAm8qvAGogCiALQQV0IAVBCnRzc0Gx893xeWxBD3ZB/P8HcSANaiIIKAIAIgk2AgAgCCAaNgIAAkAgFCAZfSIgQgNTDQACQCAZUA0AICBCggJUDQAgHEGCAkcNACAeLQAAQf8BcSAeQX9qLQAAQf8BcUcNAAJAIBBB/6PoA00NAEF/DwsgEEECdEHgvaeMAGpB/4cENgIAIBBBAWohEAwBCyAXQYICIBdBggJIGyEhICCnIghBggIgCEGCAkgbIQMgFSAYrH0gIH8hGUECIQgCQCAJQQAgGkGAgH5qIgcgByAaSxsiIkgNACACIBmnIgdBCCAHQQhKGyAHIAJKGyIjQQFIDQBBAiELQQAhJCAcQYECSyElQQAhJgNAIBhBAWohGAJAAkAgACAJaiIKIAtqLQAAIB4gC2otAABHDQBBACEFIAYhDAJAA0AgDCEHIAUiCEEEaiIFIANKDQEgB0EEaiEMIAogCGooAAAgBiAIaigAAEYNAAsLAkAgCCADTg0AA0AgCiAIai0AACAHLQAARw0BIAdBAWohByAhIAhBAWoiCEcNAAsgISEICyAIIAtMDQACQCAQQf+j6ANNDQBBfw8LIBBBAnRB4L2njABqIBogCWtBEHQgC0H+ASALQf4BSBtBCHRBgAJqciAIQX1qcjYCACAQQQFqIRAgCCADRw0BIAMhCAwDCyALIQgLAkACQCAcQQJJDQAgJg0AIB0NACAlDQBBASEFIB8hByAIIBxODQELIAlB//8BcUECdEGAm9KvAEGAm8qvACAmG2ohByAmIQULIAcoAgAiCSAiSA0BIAUhJiAIIQsgJEEBaiIkICNIDQALCwJAAkACQCAeKAAAQbHz3fF5bEEOdkH8/w9xIA9qIicoAgAiJEF/Rg0AIARBAU4NAUF/ISUMAgsgJyAaNgIAIBsgEWpBfzYCACAbIBJqQX82AgAMAgtBfyEdQQAhHEF/ISNBfyElQX8hHwNAIAAgJGohJkEBIQsgHEEBaiEcIBMhCUEAIQoCQANAIAshDCAJIQUgCiIHQQRqIgogA0oNASAFQQRqIQkgDEEEaiELICYgB2ooAAAgBiAHaigAAEYNAAsLAkACQCAHIANIDQBBACEFDAELAkAgJiAHai0AACAGIAdqLQAARg0AQQEhBQwBCwJAAkACQANAICEgDCIKRg0BIApBAWohDCAFLQAAIQcgBUEBaiEFIAcgJiAKai0AAEcNAgwACwsgISEHDAELIAxBf2ohBwsgCiADSCEFCwJAICQgIkgNACAHIAhMDQACQCAQQf+j6ANNDQBBfw8LIBBBAnRB4L2njABqIBogJGtBEHQgCEH+ASAIQf4BSRtBCHRBgAJqciAHQX1qcjYCACAQQQFqIRAgByEICwJAAkACQAJAIAVFDQAgJiAHai0AACAeIAdqLQAATw0BCyAkQQJ0IBJqIgUoAgAhBwJAICNBf0cNAEEBIQogJCEfICQhIwwDCyAjQQJ0IBJqIQxBASEKICQhIwwBC0ECIQogJEECdCARaiIFKAIAIQcCQCAdQX9HDQAgJCElICQhHQwCC0ECIQogHUECdCARaiEMICQhHQsgDCAkNgIACyAFQX82AgACQCAHQX9GIgUNACAHISQgHCAESA0BCwsCQCAFDQAgI0ECdCASaiAdQQJ0IBFqIApBAUYbIAc2AgALIB8hJAsgJyAaNgIAIBsgEmogJTYCACAbIBFqICQ2AgALIBNBAWohEyAGQQFqIQYgF0F/aiEXIBYgFFINAAsLQQAgEDYC8Jq6rwAgAUECdEGQn6OFAGogEDYCACAQC/MGARV/AkACQCABQQBKDQBBAEEANgLgzcibAAwBC0HkzcibAEH/ASABQQJ0EIGAgIAAGkEAQQA2AuDNyJsAIAZBiAhqIQhBACEJA0ACQAJAIAlBAnQiCkHgzcibAGooAgAiC0F/Rw0AIAlBAWohCQwBCwJAIAUgAiAJai0AACIMQQp0IAAgCWotAABBAnRyaigCACALaiINIAlBAWoiDkECdCIPQeDNyJsAaiIQKAIATw0AIBAgDTYCACAOQQF0Ig1BsOzMogBqQQE7AQAgDUHg+46mAGpBADsBAAsCQCADIApqKAIAIhEgAyAPaigCACISTw0AIAxBjAhsIQogByAMQYSACGxqIRMCQCAOIAFIDQAgBiAKaiEUA0ACQCAEIBFBAnRqKAIAIgpBCHZB/wFxIg0gCkH/AXEiDEEDaksNACATIApBEHYiFUECdGooAgAgC2ohFiAMQQRqIRcgFCANQQJ0aiEMIAkgDWoiCkEBdCEPIApBAnRB4M3ImwBqIQoDQAJAIAwoAgAgFmoiECAKKAIATw0AIAogEDYCACAPQbDszKIAaiANOwEAIA9B4PuOpgBqIBU7AQALIAxBBGohDCAKQQRqIQogD0ECaiEPIBcgDUEBaiINRw0ACwsgEUEBaiIRIBJHDQAMAgsLIAggCmohGCAOQQF0QeCP4YEAaiEUIAlBggJqIgxBAXQiD0Hg+46mAGohGSAPQbDszKIAaiEaIAxBAnRB4M3ImwBqIRsgBiAKaiEcA0AgBCARQQJ0aigCACIKQf8BcSIPQQNqIQwgEyAKQRB2IhVBAnRqKAIAIAtqIRYCQAJAIBVBAUcNACAMQYICRw0AIBQvAQBBggJHDQAgGCgCACAWaiIKIBsoAgBPDQEgGkGCAjsBACAbIAo2AgAgGUEBOwEADAELIApBCHZB/wFxIg0gDEsNACAPQQRqIRcgHCANQQJ0aiEMIAkgDWoiCkEBdCEPIApBAnRB4M3ImwBqIQoDQAJAIAwoAgAgFmoiECAKKAIATw0AIAogEDYCACAPQbDszKIAaiANOwEAIA9B4PuOpgBqIBU7AQALIAxBBGohDCAKQQRqIQogD0ECaiEPIBcgDUEBaiINRw0ACwsgEUEBaiIRIBJHDQALCyAOIQkLIAkgAUcNAAsLIAFBAnRB4M3ImwBqKAIACwD7AgRuYW1lAAkIaG90Lndhc20B1AIYABFfX3dhc21fY2FsbF9jdG9ycwEGbWVtc2V0AgZtZW1jcHkDCHB0cl9kYXRhBAhwdHJfc2FtZQULcHRyX3N0ZXBPZmYGDHB0cl9zdGVwUGFjawcIcHRyX2Nvc3QIC3B0cl9wYXRoTGVuCQxwdHJfcGF0aERpc3QKC3B0cl9ibG9ja09mCwtwdHJfbGl0Q29zdAwLcHRyX2xlbkNvc3QNDHB0cl9kaXN0Q29zdA4Sc3RlcF9wYWNrX2NhcGFjaXR5Dw9zdGVwX3BhY2tfY291bnQQEWJ1aWxkX21hdGNoX2NhY2hlEQlwdHJfaGVhZDMSCXB0cl9oZWFkNBMKcHRyX2J0TGVmdBQLcHRyX2J0UmlnaHQVFWJ0NF9idWlsZF9tYXRjaF9jYWNoZRYYaHlicmlkX2J1aWxkX21hdGNoX2NhY2hlFw1ydW5fZ2xvYmFsX2RwBxIBAA9fX3N0YWNrX3BvaW50ZXIAgwEJcHJvZHVjZXJzAQxwcm9jZXNzZWQtYnkBBWNsYW5nYzE5LjEuNyAoL2hvbWUvcnVubmVyL3dvcmsvbGx2bS1wcm9qZWN0L2xsdm0tcHJvamVjdC9jbGFuZyBjZDcwODAyOWUwYjI4NjllODBhYmUzMWRkYjE3NWY3YzM1MzYxZjkwKQBJD3RhcmdldF9mZWF0dXJlcwQrCm11bHRpdmFsdWUrD211dGFibGUtZ2xvYmFscysPcmVmZXJlbmNlLXR5cGVzKwhzaWduLWV4dA==';
let WASM = null;
try {
  const buf = WASM_B64.length > 0
    ? Buffer.from(WASM_B64, 'base64')
    : readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hot.wasm'));
  const mod = new WebAssembly.Module(buf);
  WASM = new WebAssembly.Instance(mod, {}).exports;
  setWasm(WASM);
} catch (e) {
  // No WASM available: fall back to the pure-JS hot loops in deflate.ts.
  if (process.env.PNG_SQUEEZE_TIMING) console.error('[wasm] unavailable, using JS hot loops:', e.message);
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---- CRC-32 (PNG, ISO 3309) ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ---- PNG decode (input is colour type 6, stored, unfiltered rows; unfilter fully anyway) ----
function decodePng(bytes) {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0, height = 0, colourType = 6;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0); height = dv.getUint32(4);
      colourType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported IHDR');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (colourType !== 6) throw new Error('input is not colour type 6, got ' + colourType);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) rgba.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (i >= 4 ? rgba[o + i - 4] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (y > 0 ? rgba[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (((i >= 4 ? rgba[o + i - 4] : 0) + (y > 0 ? rgba[p + i] : 0)) >> 1);
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? rgba[o + i - 4] : 0;
        const b = y > 0 ? rgba[p + i] : 0;
        const c = y > 0 && i >= 4 ? rgba[p + i - 4] : 0;
        rgba[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error('bad filter type ' + ft);
  }
  return { width, height, rgba };
}

// ---- Analysis ----
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => ({
    rgba: [(c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff],
    word: c, count: counts.get(c),
  }));
  return { opaque, grey, colours };
}

// The one fully transparent value the image may key by tRNS instead of an alpha channel.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = index.get(((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0);
  }
  return { plte, trns, indices, entries };
}

// Astra palette-alias: for images whose tiles are mostly background + one ink
// colour, build a paired palette (background duplicated once per ink, tile
// pixels use two adjacent indices) so whole-image Sub/Up filters compress the
// tile edges better. Returns null when no tile qualifies.
function makeAliasCandidate(indices, palette, width, height, tileSize = 16) {
  if (!Number.isSafeInteger(width) || width < 1 ||
      !Number.isSafeInteger(height) || height < 1 ||
      width * height !== indices.length ||
      !Number.isSafeInteger(tileSize) || tileSize < 2) {
    throw new RangeError('Invalid raster dimensions or tile size');
  }
  const colors = palette.length;
  if (colors < 1 || colors > 256) throw new RangeError('Invalid palette size');
  if (colors < 3 || colors === 256) return null;
  const frequency = new Uint32Array(colors);
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    if (index >= colors) throw new RangeError('Pixel index exceeds palette size');
    frequency[index]++;
  }
  let background = 0;
  for (let c = 1; c < colors; c++) {
    if (frequency[c] > frequency[background]) background = c;
  }
  const across = Math.ceil(width / tileSize);
  const down = Math.ceil(height / tileSize);
  const tileInk = new Int16Array(across * down).fill(-1);
  const transitions = new Uint32Array(colors);
  for (let ty = 0; ty < down; ty++) {
    const bottom = Math.min(height, (ty + 1) * tileSize);
    for (let tx = 0; tx < across; tx++) {
      const left = tx * tileSize;
      const right = Math.min(width, left + tileSize);
      let ink = -1;
      let edges = 0;
      let eligible = true;
      for (let y = ty * tileSize; y < bottom && eligible; y++) {
        const row = y * width;
        let previous = indices[row + left];
        for (let x = left; x < right; x++) {
          const c = indices[row + x];
          if (c !== background) {
            if (ink < 0) ink = c;
            if (c !== ink) {
              eligible = false;
              break;
            }
          }
          if (previous !== c) edges++;
          previous = c;
        }
      }
      if (eligible && edges > 0) {
        tileInk[ty * across + tx] = ink;
        transitions[ink] += edges;
      }
    }
  }
  const inks = Array.from({ length: colors }, (_, c) => c)
    .filter((c) => transitions[c] > 0)
    .sort((a, b) => transitions[b] - transitions[a] || a - b)
    .slice(0, 257 - colors);
  if (inks.length < 2) return null;
  const alias = new Int16Array(colors).fill(-1);
  const normal = new Uint8Array(colors);
  const entries = [];
  for (const ink of inks) {
    alias[ink] = entries.length;
    normal[ink] = entries.length + 1;
    entries.push(palette[background], palette[ink]);
  }
  normal[background] = 0;
  for (let c = 0; c < colors; c++) {
    if (c !== background && alias[c] < 0) {
      normal[c] = entries.length;
      entries.push(palette[c]);
    }
  }
  const encoded = new Uint8Array(indices.length);
  for (let ty = 0; ty < down; ty++) {
    const bottom = Math.min(height, (ty + 1) * tileSize);
    for (let tx = 0; tx < across; tx++) {
      const ink = tileInk[ty * across + tx];
      const base = ink < 0 ? -1 : alias[ink];
      const left = tx * tileSize;
      const right = Math.min(width, left + tileSize);
      for (let y = ty * tileSize; y < bottom; y++) {
        let pos = y * width + left;
        const end = pos + right - left;
        if (base < 0) {
          for (; pos < end; pos++) encoded[pos] = normal[indices[pos]];
        } else {
          for (; pos < end; pos++) encoded[pos] = base + Number(indices[pos] !== background);
        }
      }
    }
  }
  return { indices: encoded, palette: Uint32Array.from(entries), pairedColors: inks.length };
}

// Convert a Uint32Array palette (words (R<<24)|(G<<16)|(B<<8)|A) to PLTE + tRNS.
function plteTrnsFromWords(words) {
  const plte = new Uint8Array(words.length * 3);
  let transparent = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    plte[i * 3] = (w >>> 24) & 0xff;
    plte[i * 3 + 1] = (w >>> 16) & 0xff;
    plte[i * 3 + 2] = (w >>> 8) & 0xff;
    if ((w & 0xff) !== 255) transparent = i + 1;
  }
  const trns = transparent === 0 ? null : Uint8Array.from(words.slice(0, transparent), (w) => w & 0xff);
  return { plte, trns };
}

// ---- Filters ----
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const SCREEN = Object.freeze({ level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
const FINAL = Object.freeze({ level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// Shannon entropy of a row's bytes, in bits/byte. Precomputed c*log2(c) table
// makes this a histogram + a sum over distinct bytes (no log2 in the loop).
// Minimising entropy is the right objective for DEFLATE: a row of [1,1,1,...]
// has entropy 0 but a large minsum, so minsum misjudges linear gradients.
const LOG2C = (() => {
  const t = new Float64Array(5121);
  for (let c = 1; c <= 5120; c++) t[c] = c * Math.log2(c);
  return t;
})();
function entropyOf(row) {
  const n = row.length;
  const freq = new Uint32Array(256);
  for (let i = 0; i < n; i++) freq[row[i]]++;
  let s = 0;
  for (let c = 0; c < 256; c++) {
    const f = freq[c];
    if (f) s += LOG2C[f];
  }
  return Math.log2(n) - s / n;
}

// Filtered data for one form under one choice: fixed filter 0-4, 'minsum', 'pairs', 'brute'.
// If `seq` (Uint8Array of length height) is given, it is filled with the per-row
// filter type actually used (needed by P4 band descent).
function filtered(samples, width, height, bpp, choice, raw = new Uint8Array(height * (width * bpp + 1)), seq = null) {
  const stride = width * bpp;
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      if (seq) seq[y] = choice;
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      trial[t][0] = t;
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else if (choice === 'entropy') cost = entropyOf(trial[t].subarray(1));
      else cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
    if (seq) seq[y] = type;
  }
  return raw;
}

const FILTERS = Object.freeze({
  palette: Object.freeze([0]),
  paletteByLuminance: Object.freeze([0, 'minsum', 'brute', 'entropy']),
  channels: Object.freeze([0, 1, 2, 4, 'minsum', 'pairs', 'brute', 'entropy']),
});

function formsOf(rgba, width, height) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', FILTERS.palette],
      ['luminance', FILTERS.paletteByLuminance],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
      if (order === 'count') {
        // Astra palette-alias: paired palette, whole-image Sub/Up filters.
        try {
          const paletteWords = Uint32Array.from(p.entries, (e) => e.word);
          const alias = makeAliasCandidate(p.indices, paletteWords, width, height, 16);
          if (alias) {
            const at = plteTrnsFromWords(alias.palette);
            forms.push({ colourType: 3, bpp: 1, samples: alias.indices, plte: at.plte, trns: at.trns, filters: [1, 2] });
          }
        } catch { /* alias not applicable for this image */ }
      }
    }
    // Carbon P3: let the RGB/RGBA channel form compete against Palette even
    // for non-grey images with <=256 colours (smooth gradients / anti-aliased
    // edges can compress better as channels than as indices).
    // (No early return: fall through to add the channel form below.)
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS.channels });
  return forms;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// Screen every form x filter choice by zlib level 6; return the winner (form, choice, filtered data, seq).
function screen(rgba, width, height) {
  let best = null;
  let spare = null;
  const seqBuf = new Uint8Array(height);
  for (const form of formsOf(rgba, width, height)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : new Uint8Array(size), seqBuf);
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, choice, data, bytes, seq: Uint8Array.from(seqBuf) };
      } else spare = data;
    }
  }
  return best;
}

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// P4 band coordinate descent (Carbon): flip whole 16-row bands to a single
// filter, accepting only when a windowed zlib-1 estimate strictly decreases.
// The window is the band plus one context row on each side, so cross-row
// matches (dist = rowStride) are visible to the estimator. Single pass.
const BAND_ROWS = 16;
const BAND_CANDIDATES = [0, 1, 2, 3, 4];
function bandDescent(form, data, seq, width, height) {
  const bpp = form.bpp;
  const stride = width * bpp;
  const rowLen = stride + 1;
  const samples = form.samples;
  const newData = Uint8Array.from(data);
  const newSeq = Uint8Array.from(seq);
  const bandRow = new Uint8Array(stride);
  const windowBuf = new Uint8Array((BAND_ROWS + 2) * rowLen);
  let flips = 0;
  for (let bs = 0; bs < height; bs += BAND_ROWS) {
    const be = Math.min(height, bs + BAND_ROWS);
    const wStart = Math.max(0, bs - 1);
    const wEnd = Math.min(height, be + 1);
    const wRows = wEnd - wStart;
    windowBuf.set(newData.subarray(wStart * rowLen, wEnd * rowLen), 0);
    const curCost = deflateSync(windowBuf.subarray(0, wRows * rowLen), { level: 1 }).length;
    let bestT = -1;
    let bestCost = curCost;
    for (const t of BAND_CANDIDATES) {
      let allT = true;
      for (let y = bs; y < be; y++) if (newSeq[y] !== t) { allT = false; break; }
      if (allT) continue;
      windowBuf.set(newData.subarray(wStart * rowLen, wEnd * rowLen), 0);
      for (let y = bs; y < be; y++) {
        const cur = samples.subarray(y * stride, (y + 1) * stride);
        const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
        filterRow(t, cur, prev, bpp, bandRow);
        const wAt = (y - wStart) * rowLen;
        windowBuf[wAt] = t;
        windowBuf.set(bandRow, wAt + 1);
      }
      const c = deflateSync(windowBuf.subarray(0, wRows * rowLen), { level: 1 }).length;
      if (c < bestCost) { bestCost = c; bestT = t; }
    }
    if (bestT >= 0) {
      for (let y = bs; y < be; y++) {
        const cur = samples.subarray(y * stride, (y + 1) * stride);
        const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
        filterRow(bestT, cur, prev, bpp, bandRow);
        const at = y * rowLen;
        newData[at] = bestT;
        newData.set(bandRow, at + 1);
        newSeq[y] = bestT;
      }
      flips++;
    }
  }
  return { data: newData, seq: newSeq, flips };
}

// ---- Main: one run over every instance in the input dir. ----
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  let { form, data, choice, seq, bytes } = screen(image.rgba, image.width, image.height);
  // P4 band descent (Carbon, measured +4,246 over MDL-only): flip whole 16-row
  // bands, keeping only flips the full-stream zlib-6 verifies as better.
  // (Viterbi-lite was tried and reverted: -3,933 pts, i002 -33,441 — the DP
  // over per-row deflateSync costs optimises the wrong objective; the
  // full-stream optimal parse disagrees. See v7-build-report.)
  const bd = bandDescent(form, data, seq, image.width, image.height);
  if (bd.flips > 0) {
    // screen() already compressed this exact stream at zlib-6: bytes is
    // zlib6.length + chunkBytes(form), so reuse it instead of re-running.
    const zOrig = bytes - chunkBytes(form);
    const zBand = deflateSync(bd.data, SCREEN).length;
    if (zBand < zOrig) {
      data = bd.data;
      seq = bd.seq;
    }
  }
  if (process.env.DUMP_FILTERED) writeFileSync(`/tmp/filtered-${id}.bin`, data);
  if (process.env.PNG_SQUEEZE_TIMING) console.error(`[screen] ${id} colourType=${form.colourType} bpp=${form.bpp} choice=${String(choice)}`);
  // zlib level-9 fallback (Carbon: Z_HUFFMAN_ONLY and Z_FIXED always lose on
  // filtered screenshots, so only DEFAULT / FILTERED / RLE at memLevel 9).
  let best = null;
  for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED, constants.Z_RLE]) {
    const s = deflateSync(data, { level: 9, memLevel: 9, strategy });
    const u = new Uint8Array(s.buffer, s.byteOffset, s.length);
    if (best === null || u.length < best.length) best = u;
  }
  // Global DP (Carbon P1+P2): match cache + dual-hash + full sublen steps,
  // whole-stream forward DP with per-block Huffman cost tables, iterative
  // refinement with deterministic perturbation. Runs on every winning stream.
  // MDL dynamic blocks are always on inside deflateGlobalDP.
  // V5: maxRounds defaults to 4 in deflate.ts (timeout safety; see there).
  // V9: hybrid (V8-proven: dual-hash chain first, BT4 only extends
  // len>bestLen) is the DEFAULT match finder; set PNG_SQUEEZE_HYBRID=0 to
  // fall back to the pure dual-hash WASM path. PNG_SQUEEZE_BT4=1 selects
  // BT4-alone (known bad, -46,647; for diagnostics only).
  // PNG_SQUEEZE_BT4_DEPTH sets the BT4 tree-walk depth (default 96;
  // measured with the V8-faithful hybrid: 64->780,501, 96->782,000,
  // 128->782,022; 96 is the sweet spot, 128 adds nothing).
  // PNG_SQUEEZE_MAXROUNDS sets the DP refinement rounds (default 20;
  // measured: 14->782,000, 20->782,369 at depth 96).
  const gdp = deflateGlobalDP(data, {
    bt4: process.env.PNG_SQUEEZE_BT4 === '1',
    hybrid: process.env.PNG_SQUEEZE_HYBRID !== '0',
    bt4Depth: process.env.PNG_SQUEEZE_BT4_DEPTH ? parseInt(process.env.PNG_SQUEEZE_BT4_DEPTH, 10) : 96,
    maxRounds: process.env.PNG_SQUEEZE_MAXROUNDS ? parseInt(process.env.PNG_SQUEEZE_MAXROUNDS, 10) : 20,
  });
  if (gdp.length < best.length) best = gdp;
  if (process.env.PNG_SQUEEZE_PROBE_FILTERS) {
    // For the winning form, show every filter choice's zlib-6 AND optimal size:
    // the screen picks by zlib-6, but the final encoding is the optimal parser.
    for (const ch of form.filters) {
      const d = filtered(form.samples, image.width, image.height, form.bpp, ch);
      const z6 = deflateSync(d, SCREEN).length;
      const opt = deflateGlobalDP(d).length;
      const z9 = deflateSync(d, FINAL).length;
      console.error(`[probe] ${id} ct=${form.colourType} choice=${String(ch)} zlib6=${z6} zlib9=${z9} globalDP=${opt}`);
    }
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), pngOfForm(image.width, image.height, form, best));
}
