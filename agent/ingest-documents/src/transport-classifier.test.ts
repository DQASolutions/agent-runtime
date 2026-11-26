import { describe, expect, it } from 'vitest'
import {
  TRANSPORT_TRACKS,
  classifyTransport,
  isTextReadable,
  needsConversion,
  readabilityOf,
} from './transport-classifier.js'

describe('classifyTransport', () => {
  it('maps text extensions to native-text', () => {
    for (const ext of ['.md', '.markdown', '.txt', '.csv', '.json', '.yaml', '.yml', '.feature']) {
      expect(classifyTransport(`doc${ext}`)).toBe('native-text')
    }
  })

  it('maps pdf to native-pdf and images to native-image', () => {
    expect(classifyTransport('spec.pdf')).toBe('native-pdf')
    for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp']) {
      expect(classifyTransport(`img${ext}`)).toBe('native-image')
    }
  })

  it('maps office documents (incl. legacy) to office', () => {
    for (const ext of ['.docx', '.pptx', '.doc', '.ppt']) {
      expect(classifyTransport(`file${ext}`)).toBe('office')
    }
  })

  it('maps spreadsheets (incl. legacy) to xlsx', () => {
    expect(classifyTransport('book.xlsx')).toBe('xlsx')
    expect(classifyTransport('book.xls')).toBe('xlsx')
  })

  it('is case-insensitive on the extension', () => {
    expect(classifyTransport('PHOTO.PNG')).toBe('native-image')
    expect(classifyTransport('Plan.DOCX')).toBe('office')
  })

  it('returns null for an unknown extension', () => {
    expect(classifyTransport('archive.zip')).toBeNull()
    expect(classifyTransport('binary.exe')).toBeNull()
    expect(classifyTransport('noext')).toBeNull()
  })

  it('classifies by the final extension, full path tolerated', () => {
    expect(classifyTransport('/abs/path/to/spec.pdf')).toBe('native-pdf')
  })
})

describe('needsConversion / isTextReadable / readabilityOf', () => {
  it('flags office + xlsx as needs-conversion, others readable', () => {
    expect(needsConversion('office')).toBe(true)
    expect(needsConversion('xlsx')).toBe(true)
    expect(needsConversion('native-text')).toBe(false)
    expect(needsConversion('native-pdf')).toBe(false)
    expect(needsConversion('native-image')).toBe(false)
  })

  it('flags only native-text as text-readable', () => {
    expect(isTextReadable('native-text')).toBe(true)
    expect(isTextReadable('native-pdf')).toBe(false)
    expect(isTextReadable('native-image')).toBe(false)
    expect(isTextReadable('office')).toBe(false)
    expect(isTextReadable('xlsx')).toBe(false)
  })

  it('readabilityOf agrees with needsConversion', () => {
    expect(readabilityOf('native-text')).toBe('readable')
    expect(readabilityOf('native-pdf')).toBe('readable')
    expect(readabilityOf('native-image')).toBe('readable')
    expect(readabilityOf('office')).toBe('needs-conversion')
    expect(readabilityOf('xlsx')).toBe('needs-conversion')
  })

  it('every track in TRANSPORT_TRACKS has a defined readability', () => {
    for (const track of Object.values(TRANSPORT_TRACKS)) {
      expect(['readable', 'needs-conversion']).toContain(readabilityOf(track))
    }
  })
})
