import fs from 'fs-extra'
import JSZip from 'jszip'
import path from 'node:path'
import XLSX from 'xlsx'
import { MIME } from './classifier.js'
import { getImageNaturalSize } from './image-size.js'
import type { ContentBlock, ImageCounter, NaturalSize } from './types.js'
import {
  type DrawingAnchor,
  getSheetDrawingMap,
  injectDimensions,
  parseDrawingXml,
  parseSheetDimensions,
} from './xlsx-parser.js'

interface ImageRegistryEntry {
  id: string
  anchor: DrawingAnchor
  sectionLabel: string
  merge: XLSX.Range | null
  nat: NaturalSize | null
  startRow: number
  endRow: number
}

function findImageContext(ws: XLSX.WorkSheet, anchor: DrawingAnchor): string | null {
  const { fromCol: col, fromRow: row } = anchor
  const labels: { r: number; text: string }[] = []
  for (let r = row; r >= Math.max(0, row - 3); r--) {
    for (let c = Math.max(0, col - 3); c <= col + 2; c++) {
      const v = ws[XLSX.utils.encode_cell({ r, c })]?.v
      if (v && String(v).trim().length > 2) labels.push({ r, text: String(v).trim() })
    }
  }
  const colA = ws[XLSX.utils.encode_cell({ r: row, c: 0 })]?.v
  if (colA && String(colA).trim().length > 2) labels.push({ r: row, text: String(colA).trim() })
  if (!labels.length) return null
  labels.sort((a, b) => Math.abs(a.r - row) - Math.abs(b.r - row))
  return labels[0].text
}

function findMerge(ws: XLSX.WorkSheet, col: number, row: number): XLSX.Range | null {
  for (const m of ws['!merges'] ?? []) {
    if (col >= m.s.c && col <= m.e.c && row >= m.s.r && row <= m.e.r) return m
  }
  return null
}

function buildImageRegistry(
  anchors: DrawingAnchor[],
  ws: XLSX.WorkSheet,
  sheetName: string,
  counter: ImageCounter,
): ImageRegistryEntry[] {
  const registry: ImageRegistryEntry[] = []
  for (const anchor of anchors) {
    const idx = counter.next++
    const id = `image-${idx}`
    const sectionLabel = findImageContext(ws, anchor) ?? `Embedded image in ${sheetName}`
    const merge = findMerge(ws, anchor.fromCol, anchor.fromRow)
    const startRow = merge ? merge.s.r : anchor.fromRow
    const endRow = merge ? merge.e.r : anchor.fromRow
    const nat = getImageNaturalSize(anchor.buffer)
    registry.push({ id, anchor, sectionLabel, merge, nat, startRow, endRow })
  }
  return registry
}

function buildImageBlocks(
  entry: ImageRegistryEntry,
  sheetName: string,
  xlsxFilename: string,
  imagesDir: string,
): ContentBlock[] {
  const { id, anchor, sectionLabel, merge, nat } = entry
  const mergeStr = merge ? XLSX.utils.encode_range(merge) : 'none'
  const natStr = nat ? `${nat.width}x${nat.height}px` : 'unknown'
  const mime = MIME[`.${anchor.ext}`] ?? 'image/png'

  const imageFileName = `${id}-${anchor.filename}`
  const imagePath = path.join(imagesDir, imageFileName)
  fs.writeFileSync(imagePath, anchor.buffer)
  const absolutePath = path.resolve(imagePath)

  return [
    {
      type: 'text',
      text: [
        `## ${id}: ${anchor.filename}`,
        `- Source: ${xlsxFilename} → Sheet: "${sheetName}"`,
        `- Section: ${sectionLabel}`,
        `- Position in sheet: Rows ${entry.startRow + 1}–${entry.endRow + 1}`,
        `- Anchor: Row ${anchor.fromRow + 1}, Column ${XLSX.utils.encode_col(anchor.fromCol)}`,
        `- Merge region: ${mergeStr}`,
        `- Natural size: ${natStr}`,
        `- Anchor type: ${anchor.anchorType}`,
        `- File saved: ${absolutePath}`,
      ].join('\n'),
    },
    {
      type: 'image',
      source: { type: 'base64', media_type: mime, data: anchor.buffer.toString('base64') },
    },
  ]
}

function buildSheetText(
  ws: XLSX.WorkSheet,
  sheetName: string,
  fname: string,
  imageRegistry: ImageRegistryEntry[],
): ContentBlock {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
  const merges = ws['!merges'] ?? []

  const merged = new Set<string>()
  for (const m of merges) {
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r !== m.s.r || c !== m.s.c) merged.add(`${r},${c}`)
      }
    }
  }

  const imageAtRow: Record<number, ImageRegistryEntry[]> = {}
  const imageRowRanges = new Set<number>()
  for (const entry of imageRegistry) {
    if (!imageAtRow[entry.startRow]) imageAtRow[entry.startRow] = []
    imageAtRow[entry.startRow].push(entry)
    for (let r = entry.startRow; r <= entry.endRow; r++) imageRowRanges.add(r)
  }

  const lines: string[] = [`## Sheet: ${sheetName}`, `Source: ${fname}`, '']
  let inTable = false
  let hdrCols = 0

  for (let r = range.s.r; r <= range.e.r; r++) {
    if (imageAtRow[r]) {
      if (inTable) {
        inTable = false
        lines.push('')
      }
      for (const entry of imageAtRow[r]) {
        lines.push(`> **→ [${entry.id}]** ${entry.sectionLabel}`)
        lines.push(
          `> File: ${entry.id}-${entry.anchor.filename} | ` +
            `Rows ${entry.startRow + 1}–${entry.endRow + 1} | ` +
            `${entry.merge ? XLSX.utils.encode_range(entry.merge) : 'no merge'}`,
        )
        lines.push('')
      }
    }

    if (imageRowRanges.has(r)) continue

    const cells: { col: number; value: string }[] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (merged.has(`${r},${c}`)) continue
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (cell && cell.v !== undefined && cell.v !== null) {
        const v = String(cell.v).replace(/\r\n?/g, ' ').replace(/\n/g, ' ').trim()
        if (v) cells.push({ col: c, value: v })
      }
    }

    if (!cells.length) {
      if (inTable) {
        inTable = false
        lines.push('')
      }
      continue
    }

    if (cells.length >= 5 && !inTable) {
      inTable = true
      hdrCols = cells.length
      const h = cells.map((c) => c.value.substring(0, 50))
      lines.push('| ' + h.join(' | ') + ' |')
      lines.push('|' + h.map(() => '---').join('|') + '|')
      continue
    }

    if (inTable && cells.length >= 3) {
      const vals: string[] = []
      for (let i = 0; i < Math.max(hdrCols, cells.length); i++) {
        vals.push(cells[i]?.value?.substring(0, 80) ?? '')
      }
      lines.push('| ' + vals.join(' | ') + ' |')
      continue
    }

    inTable = false
    if (cells.length === 2) {
      lines.push(`**${cells[0].value}:** ${cells[1].value}`)
    } else if (cells.length === 1) {
      lines.push(cells[0].value.length < 60 ? `### ${cells[0].value}` : cells[0].value)
    } else {
      lines.push(cells.map((c) => c.value).join(' | '))
    }
  }

  return { type: 'text', text: lines.join('\n') }
}

export interface XlsxResult {
  blocks: ContentBlock[]
  sheetCount: number
  imageCount: number
  warnings: string[]
}

/**
 * Convert an XLSX file into the structured content-block stream used by the
 * packager. Sheets become markdown (tables + headings + image references);
 * each embedded image becomes a label block followed by an image block.
 */
export async function handleXlsx(
  filePath: string,
  counter: ImageCounter,
  imagesDir: string,
): Promise<XlsxResult> {
  const blocks: ContentBlock[] = []
  const warnings: string[] = []
  const fname = path.basename(filePath)
  const zipBuf = fs.readFileSync(filePath)
  const zip = await JSZip.loadAsync(zipBuf)
  const wb = XLSX.read(zipBuf, { type: 'buffer', cellStyles: true })
  const drawingMap = await getSheetDrawingMap(zip)

  const media: Record<string, Buffer> = {}
  for (const [zp, ze] of Object.entries(zip.files)) {
    if (zp.startsWith('xl/media/') && !ze.dir) {
      media[zp.split('/').pop() as string] = Buffer.from(await ze.async('arraybuffer'))
    }
  }

  let totalImages = 0
  for (let si = 0; si < wb.SheetNames.length; si++) {
    const sn = wb.SheetNames[si]
    const ws = wb.Sheets[sn]

    const dims = await parseSheetDimensions(zip, si)
    injectDimensions(ws, dims.colWidths, dims.rowHeights)

    let anchors: DrawingAnchor[] = []
    if (drawingMap[si]) {
      const dXml = await zip.file(drawingMap[si])?.async('string')
      const rXml = await zip
        .file(drawingMap[si].replace('xl/drawings/', 'xl/drawings/_rels/') + '.rels')
        ?.async('string')
      if (dXml && rXml) anchors = parseDrawingXml(dXml, rXml, media)
      else warnings.push(`sheet "${sn}": drawing XML or rels missing`)
    }

    for (const a of anchors) {
      if (a.anchorType === 'oneCell') {
        warnings.push(`sheet "${sn}": image "${a.filename}" uses oneCellAnchor — position approximate`)
      }
    }

    const registry = buildImageRegistry(anchors, ws, sn, counter)
    blocks.push(buildSheetText(ws, sn, fname, registry))

    for (const entry of registry) {
      blocks.push(...buildImageBlocks(entry, sn, fname, imagesDir))
      totalImages++
    }
  }

  return { blocks, sheetCount: wb.SheetNames.length, imageCount: totalImages, warnings }
}
