# JUEE POS · Rà soát trước triển khai

## Phạm vi

Đã rà mã nguồn xác thực, phân quyền và phân tách chi nhánh, Super Admin, thuê bao, thanh toán, bán lẻ, gọi món QR, kho, hội viên, khách sạn, vé, nhân sự, báo cáo và cấu hình dựng API, web app, website giới thiệu. Việc rà soát dựa trên mã nguồn và bộ kiểm thử của dự án. Dữ liệu thật, thiết bị tại quầy và hạ tầng production cần kiểm tra riêng ở staging.

## Những điểm đã xử lý

| Khu vực | Thay đổi |
| --- | --- |
| Tài khoản và email | Đăng ký công khai yêu cầu SMTP và xác minh OTP trước khi cấp quyền đăng nhập. Mã gồm 6 chữ số, hết hạn sau 10 phút, dùng một lần, tối đa 5 lần nhập. Gửi lại trong khoảng chờ 60 giây giữ mã đang có hiệu lực. |
| Quyền Super Admin | UI dùng quyền ghi trả về từ phiên đã xác thực. API kiểm tra quyền đọc hoặc ghi riêng và yêu cầu MFA cho Super Admin. Khóa tài khoản doanh nghiệp thu hồi các phiên. Tài khoản quản trị dùng quy trình vận hành riêng. |
| Yêu cầu thuê bao | Có hàng chờ, lọc theo hạn dùng, hồ sơ doanh nghiệp và lịch sử. Duyệt kiểm tra yêu cầu hiện tại, trạng thái doanh nghiệp và hạn mức gói. Kích hoạt, ghi thực thu và ghi nhật ký cùng giao dịch. Từ chối lưu lý do cho chủ doanh nghiệp. |
| Dữ liệu và môi trường public | API mặc định gửi `Cache-Control: private, no-store`. Web app thêm tiêu đề chặn nhúng trang và đọc sai kiểu nội dung. Production kiểm tra HTTPS, SMTP và các chỉ mục duy nhất hoặc TTL quan trọng trước khi khởi động. |

## Điều kiện trước khi bật production

| Ưu tiên | Phát hiện hoặc giới hạn xác minh | Việc cần hoàn tất ở staging |
| --- | --- | --- |
| Chặn phát hành | Cấu hình đang làm việc thiếu `SMTP_URL` và `MAIL_FROM`. Phần gửi OTP thật tới hộp thư chưa được xác nhận. | Thêm thông tin SMTP vào nơi lưu bí mật trên máy triển khai. Thử đăng ký, nhận OTP, gửi lại và đăng nhập trên tên miền HTTPS dự kiến. |
| Chặn phát hành | Cả ba bộ kiểm thử tích hợp dừng ở bước kết nối MongoDB trong môi trường hiện tại. Giao dịch đồng thời với dữ liệu thật cần kiểm chứng. | Chạy bộ test trên MongoDB replica set thử nghiệm. Kiểm tra chỉ mục, sao lưu và thử khôi phục trước khi áp dụng cho database thật. [MongoDB](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/) |
| Chặn phát hành | Truy vấn `npm audit` không kết nối được npm Registry. Chưa xác nhận tình trạng lỗ hổng đã công bố của toàn bộ cây phụ thuộc. | Chạy audit trên CI hoặc máy staging truy cập được registry. Đánh giá kết quả trên đúng `package-lock.json` sẽ deploy. [npm](https://docs.npmjs.com/cli/commands/npm-audit/) |
| Cao khi chạy nhiều bản sao | `backend/src/middleware/rate-limits.ts` dùng bộ nhớ của từng tiến trình. Nếu API chỉ thấy IP của proxy, nhiều khách có thể dùng chung một hạn mức. | Đặt giới hạn ở reverse proxy hoặc kho đếm dùng chung. Kiểm tra đường đến API và cấu hình số proxy tin cậy theo sơ đồ triển khai thực tế. [Next.js](https://nextjs.org/docs/pages/guides/self-hosting) |
| Cần thử tại quầy | QR gọi món kiểm tra khoảng cách bằng vị trí do trình duyệt cung cấp. Tọa độ đó chỉ nên dùng như một tín hiệu bổ sung cho phiên bàn và khâu xác nhận của cửa hàng. | Kiểm tra thiết bị từ chối quyền vị trí, QR hết hiệu lực, chính sách phục vụ theo bàn, máy in và đầu đọc mã trước khi mở bán thật. |
| Cải tiến tiếp theo | Gói thuê bao vẫn được đối soát thủ công theo mã giao dịch. Báo cáo doanh thu nền tảng tải các bản ghi thực thu của năm vào tiến trình API. | Nếu khối lượng tăng, ưu tiên đối soát thuê bao qua quy trình thanh toán riêng và chuyển tổng hợp doanh thu theo tháng xuống MongoDB. |

## Kết quả tại workspace

- `npm run build` thành công cho API và web app. `npm test` gồm 55 bài kiểm thử đơn vị đạt.
- Bài tích hợp có kịch bản phân quyền, xác minh OTP, từ chối rồi duyệt lại gói, bán và hoàn tiền, soát vé, lưu trú và bán hàng tại quầy dịch vụ. Cả ba suite cần chạy lại với MongoDB thử nghiệm có thể kết nối.
- Chưa kiểm thử gửi thư thật, cấu hình proxy và thiết bị thực tế. Xem quy trình ở [Triển khai JUEE POS](./deployment.md).
