# Tiến độ triển khai JUEE POS

| Giai đoạn | Mã nguồn và chức năng | Còn cần xác minh hoặc bổ sung |
|---|---|---|
| 1. Dữ liệu và xác thực | `db.ts`, `models.ts`, `auth.ts`, `account-email.ts`, `indexes.ts`, `seed.ts`. Mongoose, giữ collection cũ, OTP email, Argon2, JWT, TOTP, thu hồi phiên. | Khởi động với MongoDB replica set và SMTP thực tế. |
| 2. SaaS | `tenants.ts`, `business-access.ts`, `operations.ts` và dashboard. Onboarding, loại chi nhánh kết hợp, RBAC, cấp quyền cho tài khoản nhân viên hiện có. API `/tenants`, `/branches`, `/staff`, `/customers`, `/registers`, `/shifts`. | Lời mời qua email, vai trò tự định nghĩa. Đối soát riêng tiền hoàn và các khoản chi tiền mặt trong ca. |
| 3. POS | `catalog.ts`, `sales.ts`. Danh mục, biến thể, barcode, giá chi nhánh và giỏ hàng. API `/products`, `/categories`, `/orders`, `/checkout`. | Kiểm tra thanh toán đồng thời trên replica set. |
| 4. Nhà hàng | `restaurant.ts`, `qr.ts`, `realtime.ts`, `/order/[tenantId]/[tableToken]`. Khu vực, bàn, gọi món theo vị trí, gộp đơn và trạng thái từng món. API `/tables`, `/table-sessions`, `/guest`, `/kitchen`. | Kiểm tra QR bằng điện thoại qua HTTPS. SSE xử lý cập nhật bếp. |
| 5. Thuê bao | Seed mặc định Free–Business, giá tháng/năm, PlanVersion, kiểm tra hạn và tính năng. API `/plans`, `/platform/subscriptions`, `/platform/invoices`. | Tự phục vụ đổi gói, gia hạn tự động và đối soát thanh toán thuê bao qua nhà cung cấp. |
| 6. Super Admin | `platform.ts` và `/super-admin`. Quản lý tài khoản, doanh nghiệp, chi nhánh, gói, thuê bao, doanh thu, thông báo, audit log và tình trạng hệ thống. | Chạy lại các thao tác quản trị với tài khoản MFA thật sau khi cấp quyền. |
| 7. Thanh toán và báo cáo | `sales.ts`, `operations.ts`. Thu tiền từng phần, VietQR, webhook SePay có chống trùng, hoàn tiền, in hóa đơn và báo cáo theo chi nhánh. API `/bills`, `/payments/:id/refunds`, `/reports`. | Xác minh webhook bằng tài khoản SePay, tách hóa đơn theo từng món và đối soát chi tiền mặt trong ca. |

## Kiểm tra đã thực hiện

- `npm test`. Kiểm tra phân quyền, giới hạn chi nhánh, cách biểu diễn tiền và ID, validation và sinh QR.
- `npm run build`. Build TypeScript của NestJS và Next.js production.
- `npm run test:integration`. Suite bao gồm cách ly doanh nghiệp, bán đồng thời, chống trùng, OTP, QR, bếp, webhook và thuê bao. Môi trường thực thi chặn mở cổng local nên suite dừng ở kết nối MongoDB. Chạy lại với replica set dùng riêng cho test theo README.

## Đối chiếu tính năng POS

| Nghiệp vụ | Có trong JUEE POS | Có thể bổ sung |
|---|---|---|
| Phục vụ tại bàn | Gọi món QR và tại quầy, bếp, chuyển bàn trống, đặt trước theo giờ, số khách, lọc theo khu vực hoặc trạng thái | Lịch nhiều lượt đặt cho một bàn, danh sách chờ và gộp các bàn đang phục vụ |
| Thanh toán | Giảm giá bàn, thu nhiều lần bằng tiền mặt và QR, chia đều số dư khi thu từng phần | Tách hóa đơn theo từng món hoặc từng khách, thanh toán thẻ và hóa đơn điện tử |
| Thực đơn và buffet | Tạm ngừng bán theo SKU và chi nhánh, tính giá buffet theo suất người lớn hoặc trẻ em, món tính riêng theo giá thực đơn | Nhiều mức giá buffet theo giờ hoặc ngày |
| Báo cáo và khách hàng | Xuất CSV doanh thu theo chi nhánh, danh bạ khách, quản lý hội viên và lượt vào | Tích điểm, đổi thưởng và phân nhóm khách |
| Vận hành | Web POS, phân quyền theo chi nhánh và cập nhật bếp qua SSE | Bán khi mất mạng và đồng bộ giao dịch sau khi kết nối lại |

Tài liệu đối chiếu gồm [iPOS POSPC](https://huongdan.ipos.vn/docs/bang-tinh-nang-phan-mem-ipos-vn/tinh-nang-phan-mem-pospc/), [đặt bàn KiotViet](https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/fnb-nhan-dat-ban/nhan-dat-ban/), [chuyển hàng KiotViet](https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-hang-hoa/chuyen-hang/), [chia hóa đơn Square](https://squareup.com/help/us/en/article/8165-split-a-payment-and-check-with-square-for-restaurants) và [gọi món Toast](https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens).
