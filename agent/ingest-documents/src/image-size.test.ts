import { describe, expect, it } from 'vitest'
import { getImageNaturalSize } from './image-size.js'

function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  buf[0] = 0x89
  buf[1] = 0x50
  buf[2] = 0x4e
  buf[3] = 0x47
  buf[4] = 0x0d
  buf[5] = 0x0a
  buf[6] = 0x1a
  buf[7] = 0x0a
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function jpegHeader(width: number, height: number): Buffer {
  // Minimal JPEG: SOI + SOF0 marker with length + precision + height + width + components
  const buf = Buffer.alloc(30)
  buf[0] = 0xff
  buf[1] = 0xd8 // SOI
  buf[2] = 0xff
  buf[3] = 0xc0 // SOF0
  buf.writeUInt16BE(11, 4) // segment length
  buf[6] = 8 // precision
  buf.writeUInt16BE(height, 7)
  buf.writeUInt16BE(width, 9)
  return buf
}

describe('getImageNaturalSize', () => {
  it('reads PNG dimensions from header', () => {
    expect(getImageNaturalSize(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it('reads JPEG dimensions from SOF0', () => {
    expect(getImageNaturalSize(jpegHeader(800, 600))).toEqual({ width: 800, height: 600 })
  })

  it('returns null for buffers too short', () => {
    expect(getImageNaturalSize(Buffer.alloc(10))).toBeNull()
  })

  it('returns null for unknown formats', () => {
    const buf = Buffer.alloc(32)
    buf[0] = 0x47 // GIF-ish prefix, not handled
    expect(getImageNaturalSize(buf)).toBeNull()
  })
})
