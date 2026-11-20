# Kiến trúc JUEE POS

Next.js phục vụ website, dashboard cửa hàng, menu QR và Super Admin. NestJS phục vụ REST dưới `/api/v1`. MongoDB replica set hỗ trợ transaction, Mongoose quản lý schema và index.

- User có thể tham gia nhiều Tenant qua Membership. Branch thuộc một Tenant. Owner có phạm vi toàn doanh nghiệp, các vai trò khác chỉ truy cập Branch đã được cấp. Các API nghiệp vụ đi qua xác thực phiên, kiểm tra membership, quyền theo vai trò và phạm vi chi nhánh.
- PlatformGrant cấp quyền độc lập với Membership. Access JWT trỏ đến phiên đang hoạt động. Refresh token lưu theo bản băm và xoay vòng khi gia hạn. Super Admin cần TOTP và quyền được cấp qua CLI. OTP email hết hạn sau 10 phút. Liên kết reset mật khẩu có thời hạn riêng.
- Subscription gắn với PlanVersion bất biến. Hạn mức chi nhánh, nhân viên và bàn QR được kiểm tra trong transaction. Gói mở khóa chức năng POS, QR, bếp và ca thu ngân. SaaSInvoice cung cấp số liệu thực thu của nền tảng.
- Product có nhiều ProductVariant. SKU và mã vạch có index duy nhất trong tenant. Topping lưu cùng sản phẩm. Order lưu giá và món tại thời điểm đặt hàng. Checkout tiền mặt, hóa đơn, thanh toán và các bản ghi liên quan được ghi đồng thời trong một transaction.
- Quản lý doanh nghiệp tập hợp cấu hình chi nhánh, quyền nhân viên, tồn kho và doanh thu theo các chi nhánh đã được cấp quyền. Số lượng kho lưu theo phần nghìn của đơn vị tính và được cập nhật cùng lịch sử trong một transaction. Báo cáo tổng hợp Payment và Refund theo kỳ giờ Việt Nam.
- Lượt phục vụ buffet giữ danh sách món trong gói và giá mỗi nhóm khách tại thời điểm mở bàn. Hóa đơn lưu tên gói, số suất, giá suất và các món tính phí riêng. Hệ thống kiểm tra số suất, đơn hàng và tình trạng phục vụ khi chốt hóa đơn.
- Bill gom được nhiều order của cùng lượt phục vụ. Payment ghi nhận từng lần thu. PaymentIntent cho chuyển khoản có nội dung riêng và hiệu lực 15 phút. Nhân viên xác nhận bằng mã giao dịch trên sao kê. Trạng thái món trong KitchenTicket độc lập với đơn và hóa đơn.
- Mã QR tĩnh mở menu. GuestSession được cấp cho lượt tại bàn đang mở sau khi kiểm tra vị trí và bán kính đã lưu của chi nhánh. Máy chủ kiểm tra lại vị trí mới và độ chính xác khi nhận món. Tọa độ khách được dùng để kiểm tra từng yêu cầu và không lưu vào đơn hàng. Phiên đã chốt có thể xem hóa đơn đến khi hết hạn.
- Chi nhánh phòng gym và bể bơi quản lý giá gói theo tháng, ngày hoặc lượt, với hạn dùng tùy chọn cho gói lượt. Các phương thức check-in được bật riêng theo chi nhánh. Màn hình tại cửa và máy nhận diện dùng khóa riêng. Trừ lượt và ghi lịch sử nằm trong cùng transaction.
- OutboxEvent ghi cùng transaction với thay đổi nghiệp vụ. API stream của bếp xác thực quyền chi nhánh định kỳ. Khi mất kết nối, client tiếp tục từ ID sự kiện đã đọc và tải lại dữ liệu từ REST.
- `npm run db:indexes` tạo index còn thiếu và tái sử dụng index cũ có cấu hình tương đương. Index duy nhất bảo vệ token, membership, SKU, đơn theo idempotency key và mã giao dịch chuyển khoản.
