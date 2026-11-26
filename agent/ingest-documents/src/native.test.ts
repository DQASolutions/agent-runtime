import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleImage, handlePdf, handleText } from './native.js'
import type { ImageCounter } from './types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-native-'))
})

afterEach(async () => {
  await fs.remove(tmpDir)
})

describe('handleText', () => {
  it('produces a single text block with path header and body', () => {
    const p = path.join(tmpDir, 'readme.md')
    fs.writeFileSync(p, '# Hello\nWorld')
    const blocks = handleText(p)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('text')
    if (blocks[0].type === 'text') {
      expect(blocks[0].text).toContain('## File: readme.md')
      expect(blocks[0].text).toContain('# Hello')
    }
  })
})

describe('handlePdf', () => {
  it('emits a label text block + base64 document block', () => {
    const p = path.join(tmpDir, 'spec.pdf')
    fs.writeFileSync(p, Buffer.from('%PDF-1.4 fake'))
    const blocks = handlePdf(p)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].type).toBe('text')
    expect(blocks[1].type).toBe('document')
    if (blocks[1].type === 'document') {
      expect(blocks[1].source.media_type).toBe('application/pdf')
      expect(blocks[1].source.data.length).toBeGreaterThan(0)
    }
  })
})

describe('handleImage', () => {
  it('assigns a sequential image-N id and copies the file', () => {
    const p = path.join(tmpDir, 'photo.png')
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
    const imagesDir = path.join(tmpDir, 'out', 'images')
    fs.mkdirpSync(imagesDir)
    const counter: ImageCounter = { next: 5 }

    const blocks = handleImage(p, counter, imagesDir)

    expect(counter.next).toBe(6)
    expect(blocks[0].type).toBe('text')
    if (blocks[0].type === 'text') {
      expect(blocks[0].text).toContain('## image-5: photo.png')
      expect(blocks[0].text).toContain('File saved' === 'File saved' ? 'Saved to' : '')
    }
    expect(blocks[1].type).toBe('image')
    if (blocks[1].type === 'image') {
      expect(blocks[1].source.media_type).toBe('image/png')
    }
    expect(fs.existsSync(path.join(imagesDir, 'image-5-photo.png'))).toBe(true)
  })

  it('increments counter across multiple calls', () => {
    const a = path.join(tmpDir, 'a.png')
    const b = path.join(tmpDir, 'b.png')
    fs.writeFileSync(a, Buffer.from([0x89]))
    fs.writeFileSync(b, Buffer.from([0x89]))
    const imagesDir = path.join(tmpDir, 'out', 'images')
    fs.mkdirpSync(imagesDir)
    const counter: ImageCounter = { next: 1 }

    handleImage(a, counter, imagesDir)
    handleImage(b, counter, imagesDir)

    expect(counter.next).toBe(3)
    expect(fs.existsSync(path.join(imagesDir, 'image-1-a.png'))).toBe(true)
    expect(fs.existsSync(path.join(imagesDir, 'image-2-b.png'))).toBe(true)
  })
})
