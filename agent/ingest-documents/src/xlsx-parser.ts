import { XMLParser } from 'fast-xml-parser'
import type JSZip from 'jszip'
import XLSX from 'xlsx'

const int = (v: unknown): number => parseInt(String(v ?? 0)) || 0
const charToPx = (w: number): number => Math.floor(w * 7.5 + 5)
const ptToPx = (pt: number): number => Math.round((pt * 96) / 72)

const DEF_COL = 11.375
const DEF_ROW_PT = 15

export interface DrawingAnchor {
  filename: string
  ext: string
  buffer: Buffer
  anchorType: 'twoCell' | 'oneCell'
  fromCol: number
  fromRow: number
  fromColOff: number
  fromRowOff: number
  toCol: number | null
  toRow: number | null
  toColOff: number
  toRowOff: number
  cxEmu?: number
  cyEmu?: number
}

/**
 * SheetJS often leaves `ws['!cols']` and `ws['!rows']` empty. The raw XML
 * always has correct dimensions — parse it directly.
 */
export async function parseSheetDimensions(
  zip: JSZip,
  sheetIndex: number,
): Promise<{ colWidths: Record<number, number>; rowHeights: Record<number, number> }> {
  const xml = await zip.file(`xl/worksheets/sheet${sheetIndex + 1}.xml`)?.async('string')
  if (!xml) return { colWidths: {}, rowHeights: {} }

  const colWidths: Record<number, number> = {}
  const rowHeights: Record<number, number> = {}

  for (const tag of xml.match(/<col [^/>]+\/>/g) ?? []) {
    const min = int(tag.match(/min="(\d+)"/)?.[1])
    const max = int(tag.match(/max="(\d+)"/)?.[1])
    const w = parseFloat(tag.match(/width="([^"]+)"/)?.[1] ?? '0')
    if (min && max && w) {
      const px = charToPx(w)
      for (let c = min; c <= max && c <= 500; c++) colWidths[c - 1] = px
    }
  }

  for (const tag of xml.match(/<row [^>]*ht="[^"]+"[^>]*>/g) ?? []) {
    const r = int(tag.match(/r="(\d+)"/)?.[1])
    const ht = parseFloat(tag.match(/ht="([^"]+)"/)?.[1] ?? '0')
    if (r && ht) rowHeights[r - 1] = ptToPx(ht)
  }

  return { colWidths, rowHeights }
}

export function injectDimensions(
  ws: XLSX.WorkSheet,
  colWidths: Record<number, number>,
  rowHeights: Record<number, number>,
): void {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
  const cols: { wpx: number }[] = []
  const rows: { hpx: number }[] = []
  for (let c = 0; c <= range.e.c; c++) cols[c] = { wpx: colWidths[c] ?? charToPx(DEF_COL) }
  for (let r = 0; r <= range.e.r; r++) rows[r] = { hpx: rowHeights[r] ?? ptToPx(DEF_ROW_PT) }
  ws['!cols'] = cols
  ws['!rows'] = rows
}

/**
 * Build a map of sheet index → drawing file path by reading each sheet's
 * `.rels` file.
 */
export async function getSheetDrawingMap(zip: JSZip): Promise<Record<number, string>> {
  const map: Record<number, string> = {}
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: false,
    isArray: (n) => n === 'Relationship',
  })
  for (const [zp, ze] of Object.entries(zip.files)) {
    if (!zp.startsWith('xl/worksheets/_rels/') || !zp.endsWith('.rels')) continue
    const n = zp.match(/sheet(\d+)\.xml\.rels$/)?.[1]
    if (!n) continue
    const parsed = parser.parse(await ze.async('string'))
    for (const r of parsed?.Relationships?.Relationship ?? []) {
      if ((r['@_Type'] || '').includes('drawing')) {
        map[int(n) - 1] = 'xl/' + r['@_Target'].replace(/^\.\.\//, '')
      }
    }
  }
  return map
}

/**
 * Parse a drawing XML + its rels XML and return every embedded image anchor.
 * Two kinds: `twoCellAnchor` (explicit from/to, reliable positioning) and
 * `oneCellAnchor` (from + EMU extent, often unreliable — callers should
 * fall back to merge region or natural image size for dimensions).
 */
export function parseDrawingXml(
  drawingXml: string,
  relsXml: string,
  mediaFiles: Record<string, Buffer>,
): DrawingAnchor[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: false,
    isArray: (n) =>
      ['xdr:twoCellAnchor', 'xdr:oneCellAnchor', 'Relationship'].includes(n as string),
  })

  const relsMap: Record<string, string> = {}
  try {
    const rels = parser.parse(relsXml)
    for (const r of rels?.Relationships?.Relationship ?? []) {
      relsMap[r['@_Id']] = 'xl/' + (r['@_Target'] || '').replace(/^\.\.\//, '')
    }
  } catch {
    return []
  }

  let drawing: any
  try {
    drawing = parser.parse(drawingXml)
  } catch {
    return []
  }
  const wsDr = drawing?.['xdr:wsDr'] ?? {}
  const anchors: DrawingAnchor[] = []

  for (const a of wsDr['xdr:twoCellAnchor'] ?? []) {
    const f = a['xdr:from'] ?? {}
    const t = a['xdr:to'] ?? {}
    const pic = a['xdr:pic'] ?? a?.['xdr:graphicFrame']
    if (!pic) continue
    const eid =
      pic?.['xdr:blipFill']?.['a:blip']?.['@_r:embed'] ??
      pic?.['xdr:blipFill']?.['a:blip']?.['@_embed']
    if (!eid || !relsMap[eid]) continue
    const fn = relsMap[eid].split('/').pop() as string
    const buf = mediaFiles[fn]
    if (!buf) continue
    anchors.push({
      filename: fn,
      ext: (fn.split('.').pop() ?? '').toLowerCase(),
      buffer: buf,
      anchorType: 'twoCell',
      fromCol: int(f['xdr:col'] ?? f.col),
      fromRow: int(f['xdr:row'] ?? f.row),
      fromColOff: int(f['xdr:colOff'] ?? f.colOff),
      fromRowOff: int(f['xdr:rowOff'] ?? f.rowOff),
      toCol: int(t['xdr:col'] ?? t.col),
      toRow: int(t['xdr:row'] ?? t.row),
      toColOff: int(t['xdr:colOff'] ?? t.colOff),
      toRowOff: int(t['xdr:rowOff'] ?? t.rowOff),
    })
  }

  for (const a of wsDr['xdr:oneCellAnchor'] ?? []) {
    const f = a['xdr:from'] ?? {}
    const e = a['xdr:ext'] ?? {}
    const pic = a['xdr:pic']
    if (!pic) continue
    const eid = pic?.['xdr:blipFill']?.['a:blip']?.['@_r:embed']
    if (!eid || !relsMap[eid]) continue
    const fn = relsMap[eid].split('/').pop() as string
    const buf = mediaFiles[fn]
    if (!buf) continue
    anchors.push({
      filename: fn,
      ext: (fn.split('.').pop() ?? '').toLowerCase(),
      buffer: buf,
      anchorType: 'oneCell',
      fromCol: int(f['xdr:col']),
      fromRow: int(f['xdr:row']),
      fromColOff: int(f['xdr:colOff']),
      fromRowOff: int(f['xdr:rowOff']),
      toCol: null,
      toRow: null,
      toColOff: 0,
      toRowOff: 0,
      cxEmu: int(e['@_cx'] ?? e.cx),
      cyEmu: int(e['@_cy'] ?? e.cy),
    })
  }

  return anchors
}
