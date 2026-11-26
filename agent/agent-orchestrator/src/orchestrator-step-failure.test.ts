// MỘT BƯỚC GÃY KHÔNG ĐƯỢC GIẾT CẢ LẦN CHẠY — nhưng cũng KHÔNG được để nó trôi qua im lặng.
//
// Ca thật đã đo (một triển khai thật, 04/08/2026): một bảng tính của khách không parse được làm executor ném lỗi.
// Lỗi thoát thẳng ra khỏi vòng chạy nên CẢ lần nạp tắt — kể cả những bước khai `depends: []` chẳng liên quan
// gì. Hậu quả không phải mất một tệp: **22 tệp khoẻ mạnh của kỳ đó chưa từng được đọc**.
//
// Bốn điều được gác ở đây, và ba trong số đó là hàng rào chống chính bản vá này đi quá đà:
//
//   1. bước ANH EM (không phụ thuộc) VẪN chạy       — đây là thứ bản vá sinh ra để làm
//   2. bước PHỤ THUỘC bị chặn                        — `failed` không được thoả mãn dependency
//   3. bước gãy KHÔNG bị phát lại                    — không thì lỗi tất định thành vòng lặp vô hạn
//   4. lần chạy KHÔNG báo sạch                       — `tasksFailed` phải có tên, nếu không thì lỗ dữ liệu
//                                                       trông y như một lần chạy thành công

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Orchestrator } from './orchestrator.js'
import type { WorkflowV3 } from './schema-types-v3.js'
import { getStateDir, loadState } from './state-manager.js'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-fail-'))
  await fs.mkdirp(path.join(tmpDir, '.dqa', 'projects', 'p'))
})
afterEach(async () => { await fs.remove(tmpDir) })

/** `doc` phụ thuộc `read`; `sibling` độc lập — đúng hình dạng đã sập ở công ty Y. */
const wf: WorkflowV3 = {
  name: 'ingest',
  version: 3,
  pipeline: [{ phase: 'p1' }],
  phases: {
    p1: {
      description: 'ingest',
      tasks: [
        { id: 'read', type: 'agent-task', output: 'read.md', depends: [], instruction: 'đọc tệp vào hồ' },
        { id: 'doc', type: 'agent-task', output: 'doc.md', depends: ['read'], instruction: 'dựng từ hồ' },
        { id: 'sibling', type: 'agent-task', output: 'sibling.md', depends: [], instruction: 'việc không liên quan' },
      ],
    },
  },
}

const orch = () => new Orchestrator(tmpDir, 'p', wf)

describe('bước gãy — bán kính sát thương', () => {
  it('anh em vẫn chạy, kẻ phụ thuộc bị chặn, và bước gãy không bị phát lại', async () => {
    const o = orch()
    const first = await o.start()
    expect(first.status).toBe('next')
    expect((first as { task: string }).task).toBe('read')

    // `read` ném lỗi.
    const afterFail = await o.fail('read', 'socket hang up')

    // 1 — việc kế tiếp phải là `sibling`: KHÔNG liên quan tới `read` nên không có lý do gì bị vạ lây.
    expect(afterFail.status).toBe('next')
    expect((afterFail as { task: string }).task).toBe('sibling')

    // 3 — `read` đã settled: không bao giờ được phát lại trong lần chạy này.
    const st = await loadState(getStateDir(tmpDir, 'p'))
    expect(st.tasks['read'].status).toBe('failed')
    expect(st.tasks['read'].error).toBe('socket hang up')

    await fs.outputFile(path.join(tmpDir, '.dqa', 'projects', 'p', 'sibling.md'), 'xong')
    const afterSibling = await o.done('sibling')

    // 2 — `doc` phụ thuộc `read` nên KHÔNG được chạy. Không còn việc gì phát được nữa.
    expect(afterSibling.status).toBe('blocked')
    const b = afterSibling as { gate: string; check: string }
    expect(b.gate).toBe('_step-failed')
    // NÊU TÊN: câu báo phải chỉ đúng bước gãy, không núp sau câu "for-each rỗng" như trước.
    expect(b.check).toContain('read')
  })

  it('lần chạy về đích với bước gãy thì KHÔNG được báo sạch', async () => {
    const solo: WorkflowV3 = {
      name: 'solo', version: 3, pipeline: [{ phase: 'p1' }],
      phases: { p1: { description: '', tasks: [
        { id: 'a', type: 'agent-task', output: 'a.md', depends: [], instruction: '' },
        { id: 'b', type: 'agent-task', output: 'b.md', depends: [], instruction: '' },
      ] } },
    }
    const o = new Orchestrator(tmpDir, 'p', solo)
    await o.start()
    await o.fail('a', 'tệp vượt trần kích thước')
    await fs.outputFile(path.join(tmpDir, '.dqa', 'projects', 'p', 'b.md'), 'xong')
    const end = await o.done('b')

    expect(end.status).toBe('complete')
    const s = (end as { summary: { tasksDone: number; tasksFailed?: Array<{ task: string; error: string }> } }).summary
    expect(s.tasksDone).toBe(1)
    // 4 — thứ ngăn "lỗ dữ liệu trông như thành công".
    expect(s.tasksFailed).toEqual([{ task: 'a', error: 'tệp vượt trần kích thước' }])
  })

  it('không bước nào gãy ⇒ tuyệt đối không đổi gì: `tasksFailed` VẮNG MẶT, không phải mảng rỗng', async () => {
    const solo: WorkflowV3 = {
      name: 'solo', version: 3, pipeline: [{ phase: 'p1' }],
      phases: { p1: { description: '', tasks: [
        { id: 'a', type: 'agent-task', output: 'a.md', depends: [], instruction: '' },
      ] } },
    }
    const o = new Orchestrator(tmpDir, 'p', solo)
    await o.start()
    await fs.outputFile(path.join(tmpDir, '.dqa', 'projects', 'p', 'a.md'), 'xong')
    const end = await o.done('a')

    expect(end.status).toBe('complete')
    const s = (end as { summary: Record<string, unknown> }).summary
    // Vắng mặt chứ không phải rỗng: caller kiểm bằng truthiness, mảng rỗng vẫn truthy.
    expect('tasksFailed' in s).toBe(false)
  })

  it('trạng thái `failed` sống qua lần chạy lại — không thử lại lỗi tất định', async () => {
    const o = orch()
    await o.start()
    await o.fail('read', 'không parse được')

    // Orchestrator MỚI, đọc lại state từ đĩa: đúng thứ xảy ra khi worker chạy lại lệnh.
    const o2 = orch()
    const next = await o2.next()
    expect(next.status).toBe('next')
    expect((next as { task: string }).task).toBe('sibling')   // KHÔNG phải `read`
  })
})
