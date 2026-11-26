# fuel-review — dogfood (workflow HOÀN CHỈNH, chạy được e2e)

Review chi xăng theo mô hình v1 (`docs/modeling-expert-knowledge.md`):
**khai báo cho schema/quy trình (YAML), code thật cho logic (TS).**

```
app/
  ontology.yaml          # Loại + quan hệ (GiaoDich, NhatKyXe, ChungTu, CoDo)
  workflow.yaml          # ingest → check → investigate → gate
  functions/fuel.ts      # rule (rThieuLog/rLech) + compute (reconDelta/laMayPhat) + action (emitCoDo)
  skills/investigate.md  # playbook + tools: cho bước điều tra
src/
  app.ts                 # driver: đóng vai Claude Code, điều tra qua command-set
  run.ts                 # `npm start` — chạy thật, in narrative
```

## Quy trình

1. **ingest** (tất định) — nạp hồ sơ vào ontology.
2. **check** (tất định) — chạy rule-as-function theo type → `flaggedIds`.
3. **investigate** (agent) — FieldSession dừng, trao playbook + `tools`. Driver (thay Claude Code)
   với mỗi ca bị flag: `call reconDelta`, `call laMayPhat` → quyết **emitCoDo** (vấn đề thật) hoặc
   **note** (ngoại lệ máy phát điện). Mọi thao tác qua **command-set** (`dqa-fos`) — cửa duy nhất.
4. **gate** — senior2 duyệt.

## Hai cách chạy

### A. App THẬT — lái trong phiên Claude Code (đúng mô hình)
Bước `investigate` là agent step: **Claude Code tự lái** bằng lệnh `dqa-fos`, tự suy luận khi điều tra.
Xem `.claude/commands/fuel-review.md` (slash command). Trình tự lệnh Claude chạy:

```bash
dqa-fos start --app <app> --workspace <ws> --input-file case.json   # → checkpoint
# tại bước investigate, với mỗi id trong exports.flaggedIds:
dqa-fos call reconDelta '{"id":"<id>"}'  --app <app> --workspace <ws>
dqa-fos call laMayPhat  '{"id":"<id>"}'  --app <app> --workspace <ws>
dqa-fos act emitCoDo '{"giaoDich":"<id>","lyDo":"..."}' --app <app> --workspace <ws> --actor senior
dqa-fos done investigate --app <app> --workspace <ws>              # → gate
dqa-fos approve signoff    --app <app> --workspace <ws>              # → complete
dqa-fos query CoDo        --app <app> --workspace <ws>              # các cờ đỏ
```
Mỗi lệnh là một process riêng, resume state (event-sourced + filesystem ontology). **Quyết định điều
tra là của Claude**, không hard-code. Số liệu CHỈ từ `call`; ghi CHỈ qua `act` — command-set là cửa duy nhất.

### B. Mô phỏng headless — cho test/CI (quyết định hard-code)
```bash
npm run build && npm start   # driver app.ts mô phỏng agent → in narrative
npm test                     # regression: g1 thật → cờ đỏ, g4 ngoại lệ → ghi nhận
```
`npm start` KHÔNG phải app thật — nó là harness tất định (app.ts quyết hộ) để kiểm chuỗi tự động.

Case mẫu: `g1` xăng 5tr không log (→ cờ đỏ) · `g2` xăng có log lệch 10% (sạch) · `g4` xăng không log
nhưng chứng từ "máy phát điện" (→ ngoại lệ) · `g3` không phải xăng.

> Giá trị: rule (tất định) bắt cả g1 lẫn g4; **agent phân biệt** g1 (thật) với g4 (ngoại lệ).
