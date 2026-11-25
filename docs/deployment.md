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

Nếu nền tảng triển khai trực tiếp từ mã nguồn, đặt thư mục làm việc ở gốc và dùng `npm ci --include=dev && npm run build:api` để dựng, `npm run start:api` để chạy.

## 2. Web app quản lý

Đặt `API_ORIGIN` tại **bước build**. Next.js dùng địa chỉ này để chuyển tiếp các yêu cầu từ `/api/v1` đến API. Với cùng một máy chạy Docker, dùng địa chỉ API mà container web app truy cập được.

Trên Netlify, trình duyệt gửi yêu cầu đọc chứng từ AI trực tiếp đến API khi `API_ORIGIN` là địa chỉ HTTPS. Đặt `WEB_ORIGIN` tại API bằng địa chỉ khách hàng chính. Cặp `https://juee-pos-web.netlify.app` và `https://juee-pos-web.onrender.com` được chấp nhận cùng nhau khi một trong hai là địa chỉ chính. Với địa chỉ khác, đặt `SECONDARY_WEB_ORIGIN` bằng tên miền web thứ hai, gồm giao thức và không có dấu gạch chéo ở cuối. Email tài khoản dùng `WEB_ORIGIN`. Google quay về địa chỉ web nơi người dùng bắt đầu đăng ký. Thêm `/api/v1/auth/google/callback` của từng địa chỉ sử dụng Google vào danh sách **Authorized redirect URIs** của OAuth Client.

```sh
docker build -f frontend/Dockerfile \
  --build-arg API_ORIGIN=https://api.example.com -t juee-web .
docker run --rm -p 3000:3000 juee-web
```

Nếu dựng trực tiếp trên nền tảng Node.js, chọn thư mục gốc, chạy `npm ci && npm run build:web` và chạy `npm run start:web` sau khi dựng. Trang giới thiệu ở `/`, app quản lý ở `/dashboard` và bảng giá ở `/pricing`. Đường dẫn cũ `/gioi-thieu` chuyển về trang chủ.

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
3. Tạo doanh nghiệp và chi nhánh thử, kiểm tra có thể sử dụng ngay. Thử tài khoản chỉ có quyền xem và kiểm tra việc chặn truy cập khi quản trị viên tạm dừng doanh nghiệp.
4. Chạy `npm test`, `npm run build`, `npm audit --omit=dev` và `npm run test:integration` với database thử có tên kết thúc bằng `_test`. Chạy quy trình thanh toán, hoàn tiền, soát vé, nhận/trả phòng và QR gọi món qua trình duyệt và thiết bị tại quầy.
5. Chạy qua reverse proxy cho môi trường tự quản. Cấu hình `TRUST_PROXY_HOPS` theo số proxy tin cậy trên đường đến API, bảo đảm đường vào API đi đúng tuyến đã cấu hình. Kiểm tra nhiều IP thực tế và áp giới hạn tại proxy nếu API chạy nhiều bản sao. Kiểm tra cảnh báo khi API/MongoDB/SMTP gián đoạn và chuẩn bị cách quay lại image trước.

## Gói dịch vụ và trợ lý kho AI

API công bố cấu hình miễn phí khi khởi động và ẩn các gói cũ khỏi bảng giá. Lịch sử thanh toán cũ vẫn có thể tra cứu và đối soát.

Đặt `AI_KEY_ENCRYPTION_SECRET` riêng cho API thông qua biến môi trường. Dùng giá trị ngẫu nhiên ổn định ít nhất 32 ký tự và sao lưu trong nơi quản lý bí mật. Nếu đổi giá trị, chủ doanh nghiệp cần lưu lại khóa API. Trong **Quản lý doanh nghiệp → Trợ lý kho AI**, chủ doanh nghiệp có thể lưu khóa OpenAI và Gemini riêng rồi chọn nhà cung cấp muốn dùng. Dữ liệu chứng từ được gửi đến nhà cung cấp đang chọn khi người dùng yêu cầu tạo nháp. Phiếu kho và các thay đổi thực đơn chỉ được lưu sau khi người có quyền xác nhận.

Trong **Quản lý doanh nghiệp → Kê khai thuế**, chủ doanh nghiệp có thể lưu số liệu đã đối chiếu, xuất CSV làm việc và ghi mã tiếp nhận sau khi nộp bên ngoài ứng dụng.

## Dung lượng ảnh sản phẩm

API tự nén ảnh sản phẩm tải lên khi bản WebP nhẹ hơn. Ảnh lớn được thu về tối đa 1.200 px mỗi cạnh trong bản nén. Ảnh nhỏ và ảnh động được giữ nguyên khi phù hợp. Quy trình đọc ảnh hóa đơn và lưu tài liệu nghiệp vụ vẫn dùng dữ liệu gốc.

Từ thư mục gốc, chạy `npm run images:optimize -w @juee/api` để đo dung lượng có thể giảm trên MongoDB được cấu hình. Xem kết quả `savedBytes`. Sau khi sao lưu và kiểm tra trên bản sao, dùng `npm run images:optimize -w @juee/api -- --apply` để cập nhật ảnh cũ. Có thể dùng `node backend/dist/jobs/optimize-product-images.js` trong container đã dựng. Công cụ giữ nguyên liên kết ảnh và bỏ qua sản phẩm nếu ảnh được thay trong lúc đang xử lý. Số byte tiết kiệm là dung lượng dữ liệu ảnh. MongoDB có thể giữ các khối đĩa đã cấp phát để tái sử dụng.
