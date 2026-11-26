---
name: investigate
tools: [reconDelta, laMayPhat, emitCoDo]
---
Điều tra các GiaoDich xăng bị flag (danh sách ở `exports.flaggedIds`). Với MỖI id:

1. Gọi `reconDelta` (mức lệch, đồng) và `laMayPhat` (có phải ngoại lệ "máy phát điện"?).
2. Quyết:
   - KHÔNG phải ngoại lệ → hành động `emitCoDo` với `{ "giaoDich": "<id>", "lyDo": "<lý do>" }`.
   - là ngoại lệ → `note` ghi "đã xem xét, hợp lệ — máy phát điện".

Cú pháp lệnh (positional: tên hàm/action trước, args là JSON), kèm `--app/--workspace`:
```
dqa-fos call reconDelta '{"id":"<id>"}'  --app <app> --workspace <ws>
dqa-fos call laMayPhat  '{"id":"<id>"}'  --app <app> --workspace <ws>
dqa-fos act emitCoDo '{"giaoDich":"<id>","lyDo":"..."}' --app <app> --workspace <ws> --actor senior
dqa-fos note <id> "đã xem xét, hợp lệ — máy phát điện" --app <app> --workspace <ws>
```
Ràng buộc: số liệu CHỈ lấy từ `call`; ghi CHỈ qua `act`. Không sửa dữ liệu trực tiếp.
