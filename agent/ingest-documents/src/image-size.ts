import type { NaturalSize } from './types.js'

/**
 * Read intrinsic pixel dimensions directly from PNG/JPEG headers without
 * decoding the image. Returns null for unsupported formats or truncated data.
 */
export function getImageNaturalSize(buf: Buffer): NaturalSize | null {
  if (!buf || buf.length < 24) return null

  // PNG: width at byte 16, height at byte 20 (big-endian uint32)
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }

  // JPEG: scan for SOF0 (0xFFC0) or SOF2 (0xFFC2)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2
    while (o < buf.length - 8) {
      if (buf[o] !== 0xff) {
        o++
        continue
      }
      const m = buf[o + 1]
      if (m === 0xc0 || m === 0xc2) {
        return {
          width: buf.readUInt16BE(o + 7),
          height: buf.readUInt16BE(o + 5),
        }
      }
      o += 2 + buf.readUInt16BE(o + 2)
    }
  }

  return null
}
