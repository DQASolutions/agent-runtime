import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import XLSX from 'xlsx'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleXlsx } from './xlsx-pipeline.js'
import type { ImageCounter } from './types.js'

let tmpDir: string
let imagesDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-xlsx-'))
  imagesDir = path.join(tmpDir, 'images')
  fs.mkdirpSync(imagesDir)
})

afterEach(async () => {
  await fs.remove(tmpDir)
})

function writeXlsx(sheets: Record<string, unknown[][]>): string {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(rows)
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  const filePath = path.join(tmpDir, 'test.xlsx')
  XLSX.writeFile(wb, filePath)
  return filePath
}

describe('handleXlsx', () => {
  it('emits a text block per sheet', async () => {
    const filePath = writeXlsx({
      Users: [
        ['Name', 'Email'],
        ['Alice', 'a@x.com'],
      ],
      Orders: [['ID', 'Total']],
    })
    const counter: ImageCounter = { next: 1 }
    const result = await handleXlsx(filePath, counter, imagesDir)

    expect(result.sheetCount).toBe(2)
    expect(result.imageCount).toBe(0)
    expect(result.blocks).toHaveLength(2)
    if (result.blocks[0].type === 'text') {
      expect(result.blocks[0].text).toContain('## Sheet: Users')
    }
    if (result.blocks[1].type === 'text') {
      expect(result.blocks[1].text).toContain('## Sheet: Orders')
    }
  })

  it('renders rows with ≥5 cells as a markdown table', async () => {
    const filePath = writeXlsx({
      Data: [
        ['A', 'B', 'C', 'D', 'E'],
        [1, 2, 3, 4, 5],
        [6, 7, 8, 9, 10],
      ],
    })
    const counter: ImageCounter = { next: 1 }
    const result = await handleXlsx(filePath, counter, imagesDir)
    if (result.blocks[0].type === 'text') {
      const text = result.blocks[0].text
      expect(text).toContain('| A | B | C | D | E |')
      expect(text).toContain('|---|---|---|---|---|')
      expect(text).toMatch(/\|\s*1\s*\|\s*2\s*\|\s*3\s*\|\s*4\s*\|\s*5\s*\|/)
    }
  })

  it('renders two-cell rows as key:value and single short cells as headings', async () => {
    const filePath = writeXlsx({
      Meta: [
        ['Short Heading'],
        ['Name', 'Alice'],
        ['Email', 'a@x.com'],
      ],
    })
    const counter: ImageCounter = { next: 1 }
    const result = await handleXlsx(filePath, counter, imagesDir)
    if (result.blocks[0].type === 'text') {
      const text = result.blocks[0].text
      expect(text).toContain('### Short Heading')
      expect(text).toContain('**Name:** Alice')
      expect(text).toContain('**Email:** a@x.com')
    }
  })

  it('produces no warnings for a drawing-less workbook', async () => {
    const filePath = writeXlsx({ S: [['x']] })
    const counter: ImageCounter = { next: 1 }
    const result = await handleXlsx(filePath, counter, imagesDir)
    expect(result.warnings).toEqual([])
  })
})
