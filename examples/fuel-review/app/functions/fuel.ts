// Logic củan app review chi xăng — TypeScript thật (compile → .js, kernel import).
// v1 shape: đọc thuộc tính qua `g.data.*`, theo link qua `io.neighbors(id, rel)`.

import { compute, rule, action } from '@dqa-ai-solutions/core-runtime'

const RATE_VND_PER_KM = 2700 // đ/km

/** Hàm tính: chênh lệch giữa tiền xăng thực chi và mức kỳ vọng theo số km. */
export const reconDelta = compute('reconDelta', async (args, _ctx, io) => {
  const g = await io.get(String(args.id))
  if (!g) return 0
  const log = (await io.neighbors(g.id, 'giaoDich_log'))[0]
  const expected = log ? Number(log.data.km) * RATE_VND_PER_KM : 0
  return Number(g.data.amount) - expected
})

/** Hàm tính: chi xăng này có thuộc ngoại lệ "máy phát điện" không (theo chứng từ). */
export const isGeneratorException = compute('laMayPhat', async (args, _ctx, io) => {
  const g = await io.get(String(args.id))
  if (!g) return false
  const ct = (await io.neighbors(g.id, 'giaoDich_chungTu'))[0]
  return ct?.data.purpose === 'máy phát điện'
})

/** Chi xăng mà không có nhật ký xe. */
export const rMissingLog = rule({
  on: 'GiaoDich',
  id: 'R-XANG-THIEU-LOG',
  severity: 'cao',
  khi: async (g, io) =>
    g.data.category === 'xăng' && (await io.neighbors(g.id, 'giaoDich_log')).length === 0,
})

/** Chi xăng có nhật ký nhưng lệch quá 15% so với mức kỳ vọng. */
export const rDeviation = rule({
  on: 'GiaoDich',
  id: 'R-XANG-LECH',
  severity: 'vua',
  khi: async (g, io) => {
    if (g.data.category !== 'xăng') return false
    const log = (await io.neighbors(g.id, 'giaoDich_log'))[0]
    if (!log) return false // thiếu log đã có rule riêng
    const delta = Number(g.data.amount) - Number(log.data.km) * RATE_VND_PER_KM
    return Math.abs(delta) > Number(g.data.amount) * 0.15
  },
})

/** Hành động ghi: phát cờ đỏ cho một giao dịch (chỉ senior trở lên). */
export const emitCoDo = action('emitCoDo', {
  guard: (_args, ctx) =>
    ctx.actor === 'senior' || ctx.actor === 'senior2'
      ? true
      : { ok: false, reason: 'chỉ senior mới được phát cờ đỏ' },
  effect: async (args, _ctx, io) => {
    const cd = await io.create('CoDo', { lyDo: String(args.lyDo), trangThai: 'moMo' })
    await io.link('giaoDich_coDo', String(args.giaoDich), cd.id)
    return [{ type: 'codo.created', aggregate: cd.id, payload: { lyDo: args.lyDo } }]
  },
})
