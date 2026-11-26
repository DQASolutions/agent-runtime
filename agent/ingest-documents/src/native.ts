import fs from 'fs-extra'
import path from 'node:path'
import { MIME } from './classifier.js'
import type { ContentBlock, ImageCounter } from './types.js'

export function handlePdf(filePath: string): ContentBlock[] {
  const filename = path.basename(filePath)
  return [
    {
      type: 'text',
      text: `## Source: ${filename}\n- File: ${path.resolve(filePath)}`,
    },
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: fs.readFileSync(filePath).toString('base64'),
      },
    },
  ]
}

export function handleImage(
  filePath: string,
  counter: ImageCounter,
  imagesDir: string,
): ContentBlock[] {
  const filename = path.basename(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const id = `image-${counter.next++}`
  const destPath = path.join(imagesDir, `${id}-${filename}`)
  fs.copyFileSync(filePath, destPath)

  return [
    {
      type: 'text',
      text:
        `## ${id}: ${filename}\n` +
        `- Source file: ${path.resolve(filePath)}\n` +
        `- Saved to: ${path.resolve(destPath)}\n` +
        `- Type: standalone image`,
    },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: MIME[ext] ?? 'image/png',
        data: fs.readFileSync(filePath).toString('base64'),
      },
    },
  ]
}

export function handleText(filePath: string): ContentBlock[] {
  const filename = path.basename(filePath)
  return [
    {
      type: 'text',
      text:
        `## File: ${filename}\n` +
        `- Path: ${path.resolve(filePath)}\n\n` +
        fs.readFileSync(filePath, 'utf-8'),
    },
  ]
}
