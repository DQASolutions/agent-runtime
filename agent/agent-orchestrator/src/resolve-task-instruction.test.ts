/**
 * Tests for resolveTaskInstruction. Uses dependency injection rather
 * than vi.spyOn on a sibling module — every call site passes its
 * own deps object so the code under test exercises real branches
 * with real fakes, not stubs of internal imports.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'
import {
  resolveTaskInstruction,
  type ResolveTaskInstructionDeps,
} from './resolve-task-instruction.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-resolve-'))
})

afterEach(async () => {
  await fs.remove(tmpDir)
})

interface FakeDeps extends ResolveTaskInstructionDeps {
  fetchCalls: Array<[string, string]>
  fetchTimestamps: number[]
}

function makeDeps(opts: {
  remote?: boolean
  fetch?: (wf: string, id: string) => Promise<string>
} = {}): FakeDeps {
  const fetchCalls: Array<[string, string]> = []
  const fetchTimestamps: number[] = []
  const remote = opts.remote ?? false
  const fetch = opts.fetch ?? (async () => 'DEFAULT-REMOTE-CONTENT')
  return {
    isRemoteContentMode: () => remote,
    fetchTaskInstruction: async (wf, id) => {
      fetchCalls.push([wf, id])
      fetchTimestamps.push(Date.now())
      return fetch(wf, id)
    },
    fetchCalls,
    fetchTimestamps,
  }
}

describe('resolveTaskInstruction — precedence', () => {
  it('prefers override over inline and remote', async () => {
    const overrideDir = path.join(tmpDir, '.dqa', 'overrides', 'wf', 'tasks')
    await fs.mkdirp(overrideDir)
    await fs.writeFile(path.join(overrideDir, 'task-a.md'), 'OVERRIDE')

    const deps = makeDeps({ remote: true })
    const result = await resolveTaskInstruction(tmpDir, 'wf', 'task-a', 'inline-fallback', undefined, deps)
    expect(result).toBe('OVERRIDE')
    expect(deps.fetchCalls).toHaveLength(0)
  })

  it('prefers inline over remote when no override', async () => {
    const deps = makeDeps({ remote: true })
    const result = await resolveTaskInstruction(tmpDir, 'wf', 'task-a', 'INLINE', undefined, deps)
    expect(result).toBe('INLINE')
    expect(deps.fetchCalls).toHaveLength(0)
  })

  it('falls through to remote render when no override and no inline', async () => {
    const deps = makeDeps({ remote: true, fetch: async () => 'REMOTE CONTENT' })
    const result = await resolveTaskInstruction(tmpDir, 'wf', 'task-a', undefined, undefined, deps)
    expect(result).toBe('REMOTE CONTENT')
    expect(deps.fetchCalls).toEqual([['wf', 'task-a']])
  })

  it('returns undefined when remote mode is off and no local sources', async () => {
    const deps = makeDeps({ remote: false })
    const result = await resolveTaskInstruction(tmpDir, 'wf', 'task-a', undefined, undefined, deps)
    expect(result).toBeUndefined()
    expect(deps.fetchCalls).toHaveLength(0)
  })

  it('strips expanded for-each prefixes before remote lookup (implement:story-1:backend → backend)', async () => {
    const deps = makeDeps({ remote: true, fetch: async () => 'OK' })
    await resolveTaskInstruction(tmpDir, 'wf', 'implement:story-1:backend', undefined, undefined, deps)
    expect(deps.fetchCalls).toEqual([['wf', 'backend']])
  })
})

describe('resolveTaskInstruction — failure propagation', () => {
  it('throws when remote fetch fails (no silent undefined)', async () => {
    const deps = makeDeps({
      remote: true,
      fetch: async () => {
        throw new Error('render failed: 503 Service Unavailable')
      },
    })

    await expect(
      resolveTaskInstruction(tmpDir, 'wf', 'task-a', undefined, undefined, deps),
    ).rejects.toThrow(/render failed.*503/)
  })

  it('does NOT call remote when override is present, even if remote would fail', async () => {
    const overrideDir = path.join(tmpDir, '.dqa', 'overrides', 'wf', 'tasks')
    await fs.mkdirp(overrideDir)
    await fs.writeFile(path.join(overrideDir, 'task-a.md'), 'OVERRIDE')

    const deps = makeDeps({
      remote: true,
      fetch: async () => {
        throw new Error('would have failed')
      },
    })

    const result = await resolveTaskInstruction(tmpDir, 'wf', 'task-a', undefined, undefined, deps)
    expect(result).toBe('OVERRIDE')
    expect(deps.fetchCalls).toHaveLength(0)
  })
})

describe('resolveTaskInstruction — parallel safety', () => {
  it('allows N concurrent calls (e.g. dqa next --parallel 5)', async () => {
    const deps = makeDeps({
      remote: true,
      fetch: async (_wf, taskId) => {
        await new Promise((r) => setTimeout(r, 50))
        return `rendered-${taskId}`
      },
    })

    const start = Date.now()
    const results = await Promise.all([
      resolveTaskInstruction(tmpDir, 'wf', 'a', undefined, undefined, deps),
      resolveTaskInstruction(tmpDir, 'wf', 'b', undefined, undefined, deps),
      resolveTaskInstruction(tmpDir, 'wf', 'c', undefined, undefined, deps),
      resolveTaskInstruction(tmpDir, 'wf', 'd', undefined, undefined, deps),
      resolveTaskInstruction(tmpDir, 'wf', 'e', undefined, undefined, deps),
    ])
    const elapsed = Date.now() - start

    expect(results).toEqual(['rendered-a', 'rendered-b', 'rendered-c', 'rendered-d', 'rendered-e'])
    expect(elapsed).toBeLessThan(200)
    const spread = Math.max(...deps.fetchTimestamps) - Math.min(...deps.fetchTimestamps)
    expect(spread).toBeLessThan(20)
  })
  it('đọc chỉ dẫn từ KHO CỤC BỘ khi không có override và không ở chế độ từ xa', async () => {
    const pool = path.join(tmpDir, '.dqa', 'tasks', 'ba')
    await fs.mkdirp(pool)
    await fs.writeFile(path.join(pool, 'constitution.md'), '# từ kho cục bộ')

    const got = await resolveTaskInstruction(tmpDir, 'dqa-ba', 'constitution', undefined, ['ba'], {
      isRemoteContentMode: () => false,
      fetchTaskInstruction: async () => { throw new Error('không được gọi') },
    })
    expect(got).toBe('# từ kho cục bộ')
  })

  it('override VẪN thắng kho cục bộ', async () => {
    await fs.mkdirp(path.join(tmpDir, '.dqa', 'tasks', 'ba'))
    await fs.writeFile(path.join(tmpDir, '.dqa', 'tasks', 'ba', 'x.md'), 'kho')
    await fs.mkdirp(path.join(tmpDir, '.dqa', 'overrides', 'ba', 'tasks'))
    await fs.writeFile(path.join(tmpDir, '.dqa', 'overrides', 'ba', 'tasks', 'x.md'), 'override')

    const got = await resolveTaskInstruction(tmpDir, 'dqa-ba', 'x', undefined, ['ba'], {
      isRemoteContentMode: () => false,
      fetchTaskInstruction: async () => { throw new Error('không được gọi') },
    })
    expect(got).toBe('override')
  })

})
