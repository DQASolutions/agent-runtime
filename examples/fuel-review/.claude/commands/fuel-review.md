---
name: fuel-review
description: Lái một phiên review chi xăng trên app fuel-review (drive bằng dqa-fos, BẠN là agent điều tra)
---
Bạn đang vận hành app **fuel-review** bên trong phiên Claude Code này. Đặt biến:
`APP=<app dir>`, `WS=<workspace dir>`, `CASE=<đường dẫn case.json>` (tùy chọn `--tenant <id>` để tách kỳ/khách, mặc định `default`).

Lái workflow bằng các lệnh `dqa-fos` (đọc JSON trả về sau mỗi lệnh):

1. **Bắt đầu:** `dqa-fos start --app $APP --workspace $WS --input-file $CASE`
   → ingest + check chạy tất định, dừng ở checkpoint kế.

2. **Nếu `status=agent`** (bước `investigate`): đọc `tools` và `exports.flaggedIds`.
   **Với MỖI id trong flaggedIds**, tự điều tra qua command-set (đây là phần BẠN suy luận):
   - `dqa-fos call reconDelta '{"id":"<id>"}' --app $APP --workspace $WS` → mức lệch.
   - `dqa-fos call laMayPhat '{"id":"<id>"}' --app $APP --workspace $WS` → có phải ngoại lệ máy phát điện?
   - Quyết:
     - KHÔNG ngoại lệ → `dqa-fos act emitCoDo '{"giaoDich":"<id>","lyDo":"<lý do cụ thể>"}' --app $APP --workspace $WS --actor senior`
     - là ngoại lệ → `dqa-fos note <id> "đã xem xét, hợp lệ — máy phát điện" --app $APP --workspace $WS`
   - Xong tất cả: `dqa-fos done investigate --app $APP --workspace $WS`.

3. **Nếu `status=waiting`** (gate): trình bày các cờ đỏ cho người duyệt; khi được đồng ý
   → `dqa-fos approve <gate> --app $APP --workspace $WS`.

4. **Khi `status=complete`:** `dqa-fos query CoDo --app $APP --workspace $WS`
   → tóm tắt các cờ đỏ đã phát cho người dùng.

**Ràng buộc (bắt buộc):** số liệu CHỈ lấy từ `dqa-fos call`; ghi CHỈ qua `dqa-fos act`. Tuyệt đối
không đọc/sửa file ontology trực tiếp — command-set là cửa duy nhất.
