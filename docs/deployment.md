# Triển khai JUEE POS

| Phần | Thư mục | Ví dụ địa chỉ |
|---|---|---|
| API | `backend/` | `https://api.example.com` |
| Web app | `frontend/` | `https://app.example.com` |
| Super Admin | `admin/` | `https://admin.example.com` |
| Website giới thiệu | `website/` | `https://www.example.com` |

Các tên miền trên là ví dụ. Thay bằng địa chỉ của bạn khi triển khai.

## 1. API và MongoDB

Dùng thư mục gốc làm ngữ cảnh dựng image. API dùng MongoDB replica set. Cấu hình môi trường dựa trên `backend/.env.example`, gồm `NODE_ENV=production`, `MONGODB_URI`, `JWT_SECRET`, `WEB_ORIGIN`, `SMTP_URL` và `MAIL_FROM`. Đặt `WEB_ORIGIN` là tên miền của **web app**, và dùng cùng địa chỉ HTTPS cho `PUBLIC_ORDER_ORIGIN` nếu khách quét QR từ điện thoại.

Đặt `ADMIN_WEB_ORIGIN=https://admin.example.com` nếu triển khai Super Admin. Tên miền này phải khác tên miền khách hàng trong production. Thiếu biến này thì API từ chối đăng nhập và làm mới phiên quản trị trong production.

```sh
docker build -f backend/Dockerfile -t juee-api .
docker run --rm --env-file backend/.env.production juee-api node backend/dist/jobs/seed.js
docker run --rm --env-file backend/.env.production -p 5000:5000 juee-api
```

Tệp `backend/.env.production` là tệp cấu hình của máy triển khai. Dùng `BIND_HOST=0.0.0.0` và `PORT=5000` nếu đặt lại hai giá trị này. Sau khi khởi động, kiểm tra `/api/v1/health` trên tên miền API.

Production chỉ chấp nhận HTTPS với `WEB_ORIGIN` và `PUBLIC_ORDER_ORIGIN`. API kiểm tra các chỉ mục duy nhất và TTL của những collection dùng để bảo vệ tài khoản, giao dịch, mã vé và các lần gửi lại yêu cầu. Lệnh seed ở trên tạo chỉ mục. Với database đã có gói mặc định, có thể chạy `node backend/dist/jobs/indexes.js` trong container trước khi mở bản mới.

Nếu nền tảng triển khai trực tiếp từ mã nguồn, đặt thư mục làm việc ở gốc và dùng `npm ci && npm run build:api` để dựng, `npm run start:api` để chạy.

## 2. Web app quản lý

Đặt `API_ORIGIN` tại **bước build**. Next.js dùng địa chỉ này để chuyển tiếp các yêu cầu từ `/api/v1` đến API. Với cùng một máy chạy Docker, dùng địa chỉ API mà container web app truy cập được.

```sh
docker build -f frontend/Dockerfile \
  --build-arg API_ORIGIN=https://api.example.com -t juee-web .
docker run --rm -p 3000:3000 juee-web
```

Nếu dựng trực tiếp trên nền tảng Node.js, chọn thư mục gốc, chạy `npm ci && npm run build:web` và chạy `npm run start:web` sau khi dựng. App quản lý ở `/dashboard`, bảng giá ở `/pricing` và bản giới thiệu cùng tên miền ở `/gioi-thieu`.

## 3. Super Admin

`admin/` có mã nguồn, cấu hình Next.js và lockfile riêng. Đặt `API_ORIGIN` khi dựng ứng dụng và cấu hình proxy để tên miền quản trị trỏ tới cổng 3002. Trang đăng nhập dùng `https://admin.example.com/login`.

```sh
docker build --build-arg API_ORIGIN=https://api.example.com -t juee-admin admin
docker run --rm -p 3002:3002 juee-admin
```

Với nền tảng Node.js, đặt thư mục làm việc là `admin`. Chạy `npm ci && npm run build` để dựng và `npm run start` để phục vụ. Dùng tài khoản quản trị riêng và đăng nhập lại với mã Authenticator sau khi chuyển từ bản cũ.

## 4. Website giới thiệu

Website có ngữ cảnh dựng riêng trong `website/`. Đặt `APP_ORIGIN` là địa chỉ gốc của **web app** để nút **Mở ứng dụng** dẫn đến đúng trang quản lý.

```sh
APP_ORIGIN=https://app.example.com npm run build:site
```

Đưa nội dung `website/dist/` lên hosting tĩnh. Nếu dùng Docker, chạy lệnh dưới đây từ thư mục gốc.

```sh
docker build -f website/Dockerfile \
  --build-arg APP_ORIGIN=https://app.example.com -t juee-site website
docker run --rm -p 3001:80 juee-site
```

Ở máy phát triển, chạy `npm run dev:site` để xem website tại `http://localhost:3001`. Nút **Mở ứng dụng** dùng `http://localhost:3000/dashboard` khi chưa đặt `APP_ORIGIN`.

Đặt `CONTACT_FACEBOOK_URL` và `CONTACT_INSTAGRAM_URL` thành URL HTTPS của các trang JUEE trước khi dựng website hoặc web app. Khi dùng Docker, truyền hai biến bằng `--build-arg`. Mục Liên hệ chỉ hiện nút của các trang đã có URL.

## Kiểm tra ở môi trường thử nghiệm trước khi mở công khai

1. Dùng database replica set riêng cho staging, sao lưu dữ liệu thật và thử khôi phục bản sao. Chạy seed hoặc cập nhật chỉ mục trước khi khởi động API mới. Kiểm tra health từ cả tên miền API và cổng chuyển tiếp của web app.
2. Dùng tài khoản SMTP đã được phép gửi. Qua tên miền HTTPS của staging, đăng ký một email kiểm thử, xác nhận thư nhận được, thử sai mã, gửi lại và đăng nhập sau khi xác minh. Kiểm tra thêm đặt lại mật khẩu và đăng nhập Super Admin bằng TOTP.
3. Tạo một doanh nghiệp thử, gửi yêu cầu gói, từ chối rồi gửi lại và duyệt. Đối chiếu ngày hết hạn, mã giao dịch, lịch sử quản trị và khả năng truy cập sau khi khóa hoặc hết hạn. Kiểm tra tài khoản chỉ có quyền xem.
4. Chạy `npm test`, `npm run build`, `npm audit --omit=dev` và `npm run test:integration` với database thử có tên kết thúc bằng `_test`. Chạy quy trình thanh toán, hoàn tiền, soát vé, nhận/trả phòng và QR gọi món qua trình duyệt và thiết bị tại quầy.
5. Chạy qua reverse proxy cho môi trường tự quản. Cấu hình `TRUST_PROXY_HOPS` theo số proxy tin cậy trên đường đến API, bảo đảm đường vào API đi đúng tuyến đã cấu hình. Kiểm tra nhiều IP thực tế và áp giới hạn tại proxy nếu API chạy nhiều bản sao. Kiểm tra cảnh báo khi API/MongoDB/SMTP gián đoạn và chuẩn bị cách quay lại image trước.

## Gói dịch vụ và trợ lý kho AI

Khi nâng cấp từ bảng giá cũ, đặt `APPLY_DEFAULT_SERVICE_PLANS=true` trên API cho lần triển khai đầu. API công bố gói Miễn phí và Nâng cao, thêm phiên bản mới và ẩn các gói mặc định cũ. Các thuê bao và yêu cầu thanh toán đã có tiếp tục tham chiếu phiên bản đã chọn. Tắt biến này sau khi xác minh `/api/v1/plans`. Khi chạy seed trên database mới, bảng giá được khởi tạo cùng các chỉ mục.

Đặt `AI_KEY_ENCRYPTION_SECRET` riêng cho API thông qua biến môi trường. Dùng giá trị ngẫu nhiên ổn định ít nhất 32 ký tự và sao lưu trong nơi quản lý bí mật. Nếu đổi giá trị, chủ doanh nghiệp cần lưu lại khóa OpenAI. Chủ doanh nghiệp gói Nâng cao nhập khóa OpenAI của mình trong **Quản lý doanh nghiệp → Trợ lý kho AI**. Dữ liệu chứng từ được gửi đến OpenAI khi chủ doanh nghiệp yêu cầu tạo nháp. Phiếu nhập hoặc xuất chỉ được ghi khi chủ doanh nghiệp chọn mặt hàng kho và xác nhận.

Trong **Quản lý doanh nghiệp → Kê khai thuế**, chủ doanh nghiệp có thể lưu số liệu đã đối chiếu, xuất CSV làm việc và ghi mã tiếp nhận sau khi nộp bên ngoài ứng dụng.
