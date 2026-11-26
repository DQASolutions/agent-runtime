import { describe, it, expect } from 'vitest'
import os from 'node:os'
import { LibreOfficeMissingError } from './office.js'

describe('LibreOfficeMissingError', () => {
  it('mentions LibreOffice + the .docx/.pptx use case', () => {
    const err = new LibreOfficeMissingError()
    expect(err.message).toMatch(/LibreOffice/)
    expect(err.message).toMatch(/\.docx\/\.pptx/)
  })

  it('includes an OS-appropriate install command', () => {
    const err = new LibreOfficeMissingError()
    const platform = os.platform()
    if (platform === 'darwin') {
      expect(err.message).toMatch(/brew install --cask libreoffice/)
    } else if (platform === 'linux') {
      expect(err.message).toMatch(/apt install libreoffice|dnf install libreoffice|pacman -S libreoffice/)
    } else if (platform === 'win32') {
      expect(err.message).toMatch(/winget install/i)
    } else {
      expect(err.message).toMatch(/libreoffice\.org/)
    }
  })

  it('is catchable as the typed error class', () => {
    try {
      throw new LibreOfficeMissingError()
    } catch (e) {
      expect(e).toBeInstanceOf(LibreOfficeMissingError)
      expect((e as Error).name).toBe('LibreOfficeMissingError')
    }
  })
})
