# JUEE POS

Ứng dụng quản lý bán hàng đa doanh nghiệp. Giao diện dùng Next.js App Router, API dùng NestJS, dữ liệu lưu trên MongoDB replica set qua Mongoose. Xem [kiến trúc](docs/architecture.md) và [tiến độ theo giai đoạn](docs/implementation.md).

## Cấu trúc dự án

| Thư mục | Dịch vụ | Chạy ở máy phát triển |
|---|---|---|
| `backend/` | NestJS API, MongoDB, kiểm thử | `npm run dev:api` |
| `frontend/` | Next.js, app quản lý và đặt món | `npm run dev:web` |
| `website/` | Website giới thiệu tĩnh, mã nguồn trong `website/src/` | `npm run dev:site` |
| `docs/` | Kiến trúc và hướng dẫn triển khai | |

Backend và frontend dùng chung `package-lock.json` ở thư mục gốc. Website giới thiệu là phần độc lập, mặc định chạy ở [localhost:3001](http://localhost:3001), với nút **Mở ứng dụng** dẫn tới web app. Khi chạy web app, trình dựng đồng thời tạo trang `/gioi-thieu` từ cùng mã nguồn.

Xem [triển khai riêng API, web app và website](docs/deployment.md).

## Chạy trong VS Code trên macOS

Mở thư mục `JUEE-POS` trong VS Code. Dùng Node.js 22.12+ và cài các npm workspace từ thư mục gốc.

```sh
npm install
```

Cấu hình backend nằm trong `backend/.env`. Khi cài mới, tạo tệp này từ `backend/.env.example` và đặt `JWT_SECRET` bằng giá trị tạo bởi `openssl rand -hex 32`. Cấu hình proxy frontend nằm trong `frontend/.env.local`.

- **MongoDB Atlas.** Điền URI có tên database vào `MONGODB_URI`. Tài khoản database cần quyền truy cập database và IP của máy phải nằm trong Atlas IP Access List. Máy này đã cấu hình Atlas, API cổng `5001` và web cổng `3000`.
- **MongoDB cục bộ.** Chọn URI tới replica set local trong `backend/.env`, sau đó chạy `npm run db:local`. Script dùng `mongod` trên PATH hoặc bản MongoDB 8.2.6 cho Apple Silicon tại `~/.cache/mongodb-binaries`. Các máy dùng vị trí khác có thể đặt `MONGOD_BIN`. Nếu dùng Docker Desktop, chạy `docker compose up -d --wait mongo` và dùng cổng `27017` trong URI.

Chạy `npm run db:seed` để chuẩn bị các chỉ mục và cấu hình dịch vụ miễn phí.

Mở hai terminal tại thư mục gốc.

```sh
npm run dev:api
```

```sh
npm run dev:web
```

Nếu trang đăng ký hoặc đăng nhập trả lỗi 500, kiểm tra terminal backend và mở endpoint `/api/v1/health` trên cổng API. Với cấu hình trên máy này, endpoint là [127.0.0.1:5001/api/v1/health](http://127.0.0.1:5001/api/v1/health).

| Đường dẫn | Chức năng |
|---|---|
| http://localhost:3000 | Trang giới thiệu |
| http://localhost:3000/register | Tạo tài khoản |
| http://localhost:3000/dashboard | Quản lý doanh nghiệp và chi nhánh |
| http://localhost:3000/dashboard/pos | Bán tại quầy |
| http://localhost:3000/dashboard/tables | Bàn |
| http://localhost:3000/dashboard/settings | Cài đặt thực đơn, danh mục, bàn và gói buffet |
| http://localhost:3000/dashboard/company | Quản lý doanh nghiệp, danh mục bán, giao dịch, nhân viên, kho và doanh thu |
| http://localhost:3000/dashboard/kitchen | Màn hình bếp |
| http://127.0.0.1:3002/login | Đăng nhập Super Admin |
| http://127.0.0.1:3002/super-admin/developer | Super Admin kiểm tra API, MongoDB và môi trường |
| `http://127.0.0.1:<PORT>/api/v1/health` | Kiểm tra API và MongoDB |
| `http://127.0.0.1:<PORT>/docs` | Swagger ở môi trường phát triển |

Khi đổi cổng API, cập nhật `PORT` trong `backend/.env` và `API_ORIGIN` trong `frontend/.env.local`. Dùng `frontend/.env.example` làm mẫu khi chưa có tệp. Frontend gọi API qua proxy cùng origin của Next.js. Để gọi món QR bằng điện thoại, đặt `PUBLIC_ORDER_ORIGIN` thành địa chỉ HTTPS của frontend mà điện thoại truy cập được và cấp quyền vị trí cho trang. Đặt `WEB_ORIGIN` trùng địa chỉ frontend dùng để đăng nhập.

## Dữ liệu từ bản cũ

Mongoose truy cập đúng các collection và ObjectId của bản trước. Hai trường tiền thuê bao tiếp tục đọc BSON Long và xuất chuỗi trong API. `DATABASE_URL` vẫn được chấp nhận nếu `MONGODB_URI` chưa được đặt. Schema cũ nằm trong `packages/database` để đối chiếu nếu cần.

Sao lưu database trước khi chạy bản mới trên dữ liệu vận hành. Kiểm tra trước trên bản sao và chạy `npm run db:indexes` hoặc `npm run db:seed`. Hai lệnh chỉ bổ sung index và seed bổ sung gói mặc định còn thiếu. Khi gặp trùng dữ liệu hoặc xung đột index, kiểm tra collection báo lỗi trên bản sao trước khi xử lý. Các phiên bản gói đã dùng vẫn giữ quyền và giá cũ.

## Tài khoản và Super Admin

Đặt `SMTP_URL` và `MAIL_FROM` trong `backend/.env` để gửi OTP xác minh email và liên kết đặt lại mật khẩu. Ví dụ cấu trúc URL là `smtps://USERNAME:PASSWORD@smtp.example.com:465`. Dùng địa chỉ gửi được nhà cung cấp SMTP cho phép. Tài khoản đăng ký mới cần xác minh OTP trước khi đăng nhập. OTP gồm 6 chữ số, hết hạn sau 10 phút và có tối đa 5 lần nhập. Hai lần gửi OTP thành công phải cách nhau ít nhất 60 giây.

Nếu dùng Gmail để gửi OTP, bật xác minh 2 bước và tạo [mật khẩu ứng dụng](https://myaccount.google.com/apppasswords). Điền hai dòng dưới đây với tài khoản gửi thư và mật khẩu ứng dụng của bạn. Trong `SMTP_URL`, thay dấu `@` trong tên đăng nhập bằng `%40`. Khởi động lại API sau khi lưu.

```dotenv
SMTP_URL=smtps://tenban%40gmail.com:MAT_KHAU_UNG_DUNG@smtp.gmail.com:465
MAIL_FROM=tenban@gmail.com
```

Khi thử riêng trên máy, có thể đặt `ALLOW_UNVERIFIED_LOCAL_SIGNUP=true` nếu API và web chỉ dùng địa chỉ loopback, `NODE_ENV=development` và SMTP để trống. Production yêu cầu SMTP lúc khởi động.

### Đăng nhập và đăng ký bằng Google

1. Thiết lập màn hình đồng ý và tạo OAuth Client loại **Web application** trong [Google Auth Platform](https://console.cloud.google.com/auth/clients).
2. Trong **Authorized redirect URIs**, thêm `http://localhost:3000/api/v1/auth/google/callback` nếu `WEB_ORIGIN=http://localhost:3000`. Khi triển khai, dùng `https://<tên-miền-web-khách-hàng>/api/v1/auth/google/callback`. Mở web bằng đúng địa chỉ `WEB_ORIGIN` đã cấu hình.
3. Điền `GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET` vào `backend/.env` hoặc cấu hình biến môi trường của API khi triển khai. Chạy `npm run db:indexes` rồi khởi động lại API để bật nút **Tiếp tục với Google**.

Lần đầu đăng nhập với Gmail hoặc Google Workspace sẽ tạo tài khoản khách hàng. Email đã dùng cho tài khoản JUEE POS cần đăng nhập bằng phương thức hiện có. Có thể đặt mật khẩu trong **Bảo mật tài khoản** trong vòng 5 phút sau khi đăng nhập bằng Google để sử dụng những thao tác yêu cầu xác nhận mật khẩu.

### Super Admin

Tạo Super Admin đầu tiên từ Terminal tại thư mục gốc:

```sh
npm run admin:setup -- email-cua-ban@example.com
```

Dùng email chưa đăng ký và nhập mật khẩu 16–128 ký tự. Nếu email đã có tài khoản, chạy:

```sh
npm run admin:setup -- email-cua-ban@example.com --existing
```

Nhập mật khẩu hiện tại rồi đặt mật khẩu mới. Tài khoản đã đăng ký cần hoàn tất xác minh email nếu hệ thống yêu cầu. Lệnh giữ tài khoản và dữ liệu cửa hàng, đồng thời thu hồi các phiên đăng nhập cũ. Quy trình bootstrap dừng nếu đã có Super Admin.

Khi lệnh thành công, nhập khóa thiết lập được in ra vào ứng dụng Authenticator với chế độ theo thời gian (30 giây, 6 số, SHA-1). Dùng email dành riêng cho quản trị để tài khoản chủ cửa hàng vẫn đăng nhập ở web khách hàng. Mở [đăng nhập Super Admin](http://127.0.0.1:3002/login) và nhập mã 6 số hiện tại.

Super Admin là ứng dụng Next.js trong thư mục `admin/`, với gói cài đặt và cấu hình riêng. Sao chép `admin/.env.example` thành `admin/.env.local`, đặt `API_ORIGIN` theo cổng backend đang chạy và khởi động bằng `npm run dev:admin` ở thư mục gốc. Cổng admin mặc định là `3002`. Khi cài độc lập, chạy `npm ci` và `npm run dev` trong `admin/`.

`backend/.env` dùng `ADMIN_WEB_ORIGIN` cho cổng quản trị. Sau khi nâng cấp, khởi động lại API rồi đăng nhập Super Admin ở địa chỉ mới. Cổng khách hàng dùng `WEB_ORIGIN`. Phiên Super Admin tồn tại tối đa 8 giờ và dùng cookie riêng.

## Giao diện theo mô hình chi nhánh

Sau khi đăng ký và xác minh email, chủ tài khoản chọn mô hình hoạt động cho chi nhánh. Mọi doanh nghiệp và chi nhánh được dùng miễn phí đầy đủ tính năng. Trợ lý kho AI dùng khóa OpenAI hoặc Gemini riêng của doanh nghiệp.

Các khoản thanh toán thuê bao trước đây vẫn xem được tại **Quản lý doanh nghiệp → Gói dịch vụ**. Khoản chuyển cũ cần đối soát có thể xem tại **Super Admin → Thuê bao**.

Chọn doanh nghiệp và chi nhánh ở thanh đầu trang. Khi chuyển sang nơi khác, nhập lại mật khẩu của tài khoản chủ doanh nghiệp hoặc quản lý được giao ở đó. Phiên đăng nhập giữ chi nhánh đã xác nhận khi tải lại trang. Mở menu tài khoản và chọn **Đổi tài khoản** để đăng nhập bằng tài khoản được cấp quyền ở nơi khác.

Các mô hình dùng chung thanh điều hướng, bộ lọc, thẻ và biểu mẫu. Trên màn hình rộng, danh sách món hoặc sản phẩm nằm bên trái, thao tác bán hàng và thu tiền nằm bên phải. Gym, bể bơi và thu vé dùng bố cục tương tự cho khu check-in hoặc soát vé. Màu nhấn thay đổi theo mô hình cửa hàng. Trên điện thoại, mở điều hướng bằng nút menu trên đầu trang. Chi nhánh kết hợp có nút **Bán lẻ / Nhà hàng** để chuyển giữa hai nghiệp vụ trong cùng chi nhánh.

Chủ cửa hàng hoặc quản lý chọn **Quản lý → Chuyển sang Nhân viên** trên thanh đầu trang để bàn giao quầy của chi nhánh đã chọn. Phiên này cho phép tạo và nhận đơn, phục vụ bàn, lập hóa đơn và thu tiền. Sửa đơn bán lẻ, hủy đơn, hủy hóa đơn và hoàn tiền nằm ở mục **Giao dịch** trong trang quản lý của chủ doanh nghiệp hoặc của quản lý được uỷ quyền tại chi nhánh. Chọn **Nhân viên → Mở Quản lý** rồi nhập mật khẩu tài khoản để lấy lại quyền trong phiên hiện tại.

Trong Super Admin, mục **Nhà phát triển** hiển thị trạng thái API, MongoDB, phiên bản Node.js và thời gian chạy. API kiểm tra quyền quản trị và MFA. Liên kết Swagger xuất hiện khi API chạy ngoài production.

## Thử luồng bán hàng

- Mở dashboard, tạo doanh nghiệp và chi nhánh. Tạo danh mục, thêm món hoặc sản phẩm và đặt giá bán. SKU và mã vạch dùng ở quầy bán lẻ.
- Dùng POS để thu tiền mặt hoặc tạo đơn chờ thanh toán. Với đơn chờ, vào **Đơn hàng** để lập hóa đơn và **Thanh toán** để thu tiền từng phần. Chủ doanh nghiệp có thể đặt thông tin nhận tiền ở mục **Chi nhánh**, sau đó dùng VietQR và ghi mã giao dịch từ sao kê.
- Để thử QR, chọn Nhà hàng hoặc Quán nước với gói thử hoặc gói có `qr` và `kitchen`. Ghim vị trí chi nhánh, tạo bàn và mở lượt. Khách quét QR, cấp quyền vị trí và gửi món từ trong bán kính đã đặt. Máy chủ kiểm tra vị trí khi mở phiên và mỗi lần gửi món. Nhân viên mở **Bàn → Món đã gọi**, bấm **Nhận món** để chuyển bếp. Bộ phận bếp xác nhận ra món trong **Màn hình bếp**.
- Tạo hoặc sửa thực đơn, danh mục và bàn tại **Cài đặt**. Mục **Bàn** trên thanh điều hướng dùng để phục vụ khách. Chỉ bàn đã đóng lượt và không có đặt trước mới xóa được.
- Dùng tài khoản chủ doanh nghiệp và vào **Quản lý doanh nghiệp → Gói buffet** để tạo gói, nhập giá suất người lớn và trẻ em, rồi chọn các món bao gồm. Khi mở lượt bàn, chọn tên gói và nhập số khách từng nhóm. Danh sách món và giá suất được giữ theo lượt, số khách có thể sửa trước khi chốt. Thực đơn mặc định mở **Trong gói** và ẩn giá từng món. **Gọi thêm (+ phí)** hiện giá bán và cộng vào hóa đơn cùng topping có phụ thu. Cuộn thực đơn để tải tiếp món. Sau khi bếp xác nhận ra đủ món, vào **Món đã gọi** để kiểm suất, chốt và thu tiền.
- **Màn hình bếp** ghim từng phiếu theo thứ tự gọi món, sớm nhất lên đầu. Trên màn hình rộng, mỗi hàng có tối đa ba phiếu. Khi món đã được mang ra bàn, bấm **Xác nhận đã ra món** cho từng dòng. Trong **Món đã gọi**, hệ thống hiển thị số phần chưa xác nhận và chỉ cho chốt hóa đơn khi đã ra đủ món của bàn. Nút in trên phiếu dùng khổ 58 hoặc 80 mm. Khách bấm **Món đã gọi** để theo dõi thời gian chờ và thanh toán.
- **Tổng hợp chế biến** trên màn hình bếp hiển thị tổng số phần chưa ra của cả chi nhánh. Bấm mở để xem số phần của từng món, gồm đơn tại bàn và mang về. Số lượng tự cập nhật sau khi bếp nhận đơn mới, ra món hoặc món bị hủy.
- Với nhà hàng và quán nước, bấm vào bàn để mở thực đơn và xem mã QR ở đầu trang. Trên màn hình rộng, thực đơn cuộn bên trái và **Món đã gọi** cuộn trong cột bên phải, với số tiền còn phải thu ở chân cột. Khi khách yêu cầu tính tiền, mở **Món đã gọi** để kiểm tra món đã phục vụ, nhập mã giảm giá nếu có, chốt hóa đơn và thu tiền mặt hoặc chuyển khoản. Sơ đồ bàn hiển thị thời gian kể từ khi mở lượt phục vụ. Sau khi chốt, bàn ở trạng thái **Chờ thanh toán** cho đến khi thu đủ, kể cả khi khách chia tiền. Hóa đơn vẫn có sẵn trong **Món đã gọi** để in sau khi thanh toán. Khách đã xác nhận vị trí tại bàn có thể xem hóa đơn của lượt cũ và mở VietQR nếu chi nhánh đã cấu hình tài khoản nhận tiền.
- Trong **Gọi món**, dùng ô **Phục vụ** để chọn bàn hoặc **Mang về**. Trước khi chốt hóa đơn, chọn **Mang về** để chuyển lượt đang phục vụ tại bàn và trả bàn cũ, hoặc chọn một bàn trống để chuyển đơn mang về sang ăn tại chỗ. Các món đã gửi và trạng thái bếp đi cùng lượt phục vụ. Chốt và thu tiền trong **Món đã gọi**.
- Chủ cửa hàng và quản lý có thể hủy từng món hoặc cả đợt gọi trong **Món đã gọi** bằng cách nhập lý do và bấm **Xác nhận hủy**. Món đã hủy vẫn xuất hiện cùng lý do và được loại khỏi tiền phải thu. Phiếu bếp giữ món đang chờ xử lý đã hủy cho đến khi bếp bấm **Xác nhận hủy**. Phiếu đã xử lý có thể xem trong lịch sử 24 giờ.
- Trong **Quản lý doanh nghiệp → Lịch sử hủy**, chủ doanh nghiệp có thể lọc đơn đã hủy hoặc đơn có món bị hủy theo chi nhánh đang chọn. Chi tiết hiển thị các món, số lượng, lý do và thông tin người hủy, thời điểm hủy, xác nhận của bếp khi có dữ liệu.
- Lọc sơ đồ bàn theo khu vực hoặc trạng thái. Với bàn trống, mở **Đặt trước** để ghi tên khách, số người và giờ đến. Khi đón khách, số người được đưa vào lượt phục vụ. Thu ngân có thể dùng **Chia đều số tiền còn lại** trên hóa đơn rồi thu từng phần.
- Chủ doanh nghiệp và quản lý dùng **Quản lý doanh nghiệp → Thực đơn** để **Đánh dấu hết món** hoặc **Bán lại** ở chi nhánh đang chọn. Thực đơn QR cập nhật tự động. Với database dùng từ bản trước, chạy `npm run db:indexes` để tạo index cho gói buffet và trạng thái hết món.
- Trong **Quản lý doanh nghiệp → Báo cáo**, chọn hôm nay, tuần, tháng, năm hoặc toàn bộ. Khi cần xem kỳ cũ, chọn một ngày trong kỳ theo giờ Việt Nam. Báo cáo tổng hợp số lượng và tiền theo mặt hàng nhập, hàng hoặc món đã bán, phần hụt và dư sau kiểm kê, cùng tiền thu và chi của chi nhánh. **Xuất báo cáo CSV** tải toàn bộ số liệu của kỳ.
- Lãi sau kiểm kê bằng doanh thu thuần ghi nhận, trừ giá vốn hàng đã bán, nguyên liệu đã xuất và giá trị hụt, rồi cộng giá trị dư. Lợi nhuận trước thuế trừ thêm các khoản chi phí vận hành trong Sổ quỹ. Tiền phiếu nhập được ghi ở dòng tiền chi. Giá vốn buffet ước tính được trình bày riêng.
- Người có quyền quản lý có thể ghi nhận hoàn tiền từ khoản đã thu trên hóa đơn.

Màn hình bếp dùng SSE có xác thực và đọc sự kiện đã commit từ MongoDB. Khi kết nối gián đoạn, giao diện kết nối lại và đồng bộ từ API. Thanh toán QR có thể xác nhận thủ công theo sao kê hoặc đối soát qua SePay khi cấu hình webhook. Lịch sử thu tiền SaaS được ghi nhận riêng trong Super Admin.

## Quản lý doanh nghiệp

- Đăng nhập bằng tài khoản chủ doanh nghiệp rồi chọn **Quản lý doanh nghiệp**. Menu bên trái gom các mục theo nhóm. Trên màn hình nhỏ, dùng nút **Mở điều hướng** để mở menu. Dùng bộ chọn trên cùng để đổi doanh nghiệp hoặc chi nhánh. Các chi nhánh phục vụ tại bàn có mục **Cấu hình bàn** và **Gói buffet** để quản lý cấu hình của từng địa điểm.
- Ở chi nhánh bán lẻ, mở **Sản phẩm → Đăng bán từ kho**, chọn mặt hàng rồi nhập mô tả, ảnh và giá bán trước thuế. Tên, mã hàng, mã vạch và thông tin phân loại lấy từ kho của chi nhánh. Khi tạo đơn tại quầy, mỗi đơn vị bán trừ một đơn vị tồn. Sản phẩm cũ chưa liên kết kho được nhận diện trong danh sách.
- Trong **Quản lý doanh nghiệp → Giao dịch → Đơn hàng**, mở đơn bán lẻ đang chờ thanh toán rồi chọn **Sửa đơn hàng** hoặc **Hủy đơn hàng**. Có thể thêm, bỏ, đổi số lượng sản phẩm và đổi giảm giá. Khi lưu, hệ thống cập nhật tồn theo từng lô và cập nhật hóa đơn chưa thu tiền nếu đã lập. Khi hủy, nhập lý do để trả hàng về kho và hủy hóa đơn liên quan. Mã QR chuyển khoản cũ hết hiệu lực sau khi sửa hoặc hủy. Khoản đã thu được xử lý tại **Hóa đơn và hoàn tiền**. Khi hoàn một phần, có thể nhập số lượng hàng thực nhận của từng sản phẩm.
- **Tổng quan** hiển thị khoản đã thu, tiền đã hoàn và doanh thu thuần theo ngày hoặc tháng của doanh nghiệp đang chọn. Doanh thu thuần là số tiền đã thu trừ số tiền đã hoàn trong kỳ.
- Trong **Nhân viên và quản lý → Hồ sơ nhân viên**, chủ doanh nghiệp cấp tài khoản cho vai trò **Quản lý** và chọn chi nhánh được phép truy cập. Các vai trò khác chỉ lưu hồ sơ. Khi nâng một hồ sơ lên Quản lý, liên kết tài khoản có sẵn hoặc tạo tài khoản. Khi chuyển sang vai trò khác, quyền truy cập cửa hàng bị thu hồi. Xóa hồ sơ hủy ca sắp tới và giữ lịch sử chấm công.
- Khi thêm nhân viên hoặc quản lý, nhập số CCCD đủ 12 chữ số và chọn ảnh đại diện. Mỗi hồ sơ có thể lưu thêm tối đa 8 ảnh giấy tờ JPG, PNG hoặc WebP, mỗi ảnh tối đa 4 MB và tổng ảnh mỗi lần lưu tối đa 8 MB. Số CCCD và ảnh giấy tờ chỉ xem được trong **Sửa hồ sơ** bởi người có quyền sửa hồ sơ đó. Hồ sơ cũ có thể bổ sung các trường này sau. Khi nâng lên quản lý, hoàn thiện CCCD và ảnh đại diện trước khi cấp tài khoản. Sau khi cập nhật từ bản cũ, chạy `npm run db:indexes` để tạo chỉ mục hồ sơ nhân viên.
- Chủ doanh nghiệp và quản lý dùng **Lịch ca** để xếp, sửa hoặc hủy ca tại chi nhánh. Với **Ca cố định**, chọn **Từ ngày – Đến ngày** và một khung giờ để xếp cho mỗi ngày trong khoảng, kể cả ngày cuối. Mỗi lần xếp tối đa 366 ngày. Sửa giờ ca cố định sẽ cập nhật từ ngày được chọn trở đi cho các ca chưa chấm công trong cùng lịch. Với **Ca linh động**, chọn ngày trên lịch rồi nhập giờ bắt đầu và kết thúc riêng cho ngày đó. Hệ thống chặn ca trùng giờ giữa các chi nhánh và giữ các ca đã có chấm công. Trong **Chấm công**, quản lý vẫn có thể ghi giờ vào/ra thủ công. Lượt vào được gắn vào ca trong khung giờ hoặc sớm tối đa 30 phút.
- Bấm một ngày trong **Lịch ca** để xem các ca bắt đầu ngày đó, giờ vào/ra thực tế và lượt chấm công ngoài ca. Dùng **Ghi nghỉ** để lưu lý do cho một ca chưa có chấm công. Ca đã qua giờ kết thúc mà chưa có lượt chấm công hoặc thông tin nghỉ hiển thị **Vắng mặt**.
- Bấm **Đổi ca** để hoán đổi hai ca trong cùng chi nhánh hoặc chọn người làm thay cho một ca. Hệ thống kiểm tra ca trùng giờ ở các chi nhánh và chỉ cho đổi ca chưa kết thúc, chưa chấm công và chưa ghi nghỉ. Nếu đổi một ngày trong lịch cố định, các ngày khác giữ phân công hiện tại.
- Trong **Nhân viên và quản lý → Lương**, chọn nhân viên và kỳ công theo giờ Việt Nam. Chủ doanh nghiệp và quản lý đặt mức lương thường theo giờ hoặc ca, mức tăng ca theo giờ và ngày áp dụng tại chi nhánh. Khi chọn **Theo ca**, nhập số giờ và phút của một ca. Làm thiếu giờ tính lương theo tỷ lệ thời gian thực tế, làm đủ giờ nhận đủ đơn giá và thời gian vượt chuẩn tính tăng ca. Đơn giá theo ca cũ chưa có thời lượng tiếp tục tính theo cách cũ cho đến khi được cài lại. Lương giờ tính theo phút chấm công và tăng ca sau giờ kết thúc đã xếp. Ca linh động cũ có số phút chuẩn dùng mức đã lưu khi trả theo giờ. Lượt ngoài lịch tính như giờ thường nếu trả theo giờ. Thời gian đến trước giờ mở ca được bỏ qua. Ca qua đêm tính vào ngày bắt đầu. Ca chưa kết thúc hoặc thiếu dữ liệu được liệt kê riêng.
- Sau khi đã thanh toán, chọn **Chốt lương**, chọn tiền mặt hoặc chuyển khoản và xác nhận. Phiếu giữ đơn giá và công thực tế, chặn trả trùng, và xuất hiện theo ngày xác nhận ở **Sổ quỹ → Xem phiếu lương**. **Thuế & kế toán** tách **Lương nhân viên đã trả** khỏi các chi phí nhân viên khác. Khoản này được tính một lần vào chi phí vận hành khi tính lợi nhuận trước thuế.

### Kết nối máy chấm công nhân viên

1. Vào **Nhân viên và quản lý → Máy chấm công**, thêm máy, chọn phương thức và lưu địa chỉ cùng khóa ngay khi hiển thị.
2. Đăng ký vân tay, thẻ hoặc khuôn mặt trên máy. Gắn mã mà máy gửi với đúng nhân viên và phương thức tại **Liên kết mã nhân viên**. Giữ nguyên các số 0 đứng đầu mã. JUEE POS nhận mã nhận diện đã được máy xác nhận và thời điểm quét.
3. Nếu máy hỗ trợ gửi HTTP theo cấu trúc dưới đây, có thể cấu hình gửi trực tiếp. Các máy dùng giao thức riêng cần phần mềm hoặc SDK của hãng chuyển lượt quét sang yêu cầu này. Gửi `POST` qua địa chỉ trên màn hình với `Authorization: Bearer <khóa máy>`, `Content-Type: application/json` và `Idempotency-Key` riêng cho mỗi lượt quét. Khóa chống gửi trùng gồm 16–100 ký tự chữ, số, gạch ngang hoặc gạch dưới. Khi gửi lại cùng lượt, giữ nguyên khóa và nội dung.

```json
{
  "code": "00017",
  "method": "CARD",
  "direction": "IN",
  "occurredAt": "2026-11-19T08:00:00+07:00"
}
```

`method` nhận `CARD`, `FINGERPRINT`, hoặc `FACE`. Với máy vào và ra riêng, gửi rõ `IN` hoặc `OUT`. Với máy dùng chung, gửi `AUTO` để chuyển giữa vào và ra, có lọc quét lặp trong 60 giây. Khi máy mất mạng, gửi lại các lượt theo đúng thứ tự thời gian. Hệ thống nhận lượt quét trong vòng 7 ngày trở lại đối với mã đã liên kết. Sau khi cập nhật phần mềm, chạy `npm run db:indexes` để tạo chỉ mục cho máy và mã chấm công.
- Chi nhánh gym và bể bơi có mục **Nhân viên và quản lý → Huấn luyện viên** để theo dõi chuyên môn, chứng chỉ và nơi làm việc. Chủ hoặc quản lý dùng **Lịch lớp** để phân công huấn luyện viên và điểm danh lớp.
- Khi tạo doanh nghiệp hoặc thêm chi nhánh, dùng **Ghim vị trí hiện tại** hoặc nhập tọa độ, rồi đặt bán kính gọi món từ 20 đến 2.000 m. Với chi nhánh cũ, vào **Chi nhánh → Chỉnh sửa** để lưu vị trí trước khi dùng gọi món QR.
- Quản lý dùng chung trang **Quản lý doanh nghiệp** với chủ doanh nghiệp. Vào **Nhân viên và quản lý → Hồ sơ nhân viên → Phân quyền cửa hàng** trên tài khoản quản lý để chọn các cửa hàng và chi nhánh được vào. Chủ doanh nghiệp có thể cấp cùng một email ở doanh nghiệp khác bằng **Dùng tài khoản có sẵn**. Quản lý chọn nơi làm việc từ thanh trên cùng, xem doanh thu và thao tác theo phạm vi được giao. Khi được giao đủ tất cả chi nhánh hiện có, quản lý có thể sửa món, sản phẩm và danh mục dùng chung. Quyền tạo chi nhánh, sửa tài khoản nhận tiền, ghim vị trí và quản lý gói dịch vụ thuộc chủ doanh nghiệp. Đường dẫn quản lý chi nhánh cũ chuyển về trang chung.
- Chỉ chủ doanh nghiệp được thêm tài khoản quản lý và đặt lại mật khẩu cho tài khoản quản lý do doanh nghiệp cấp, chỉ dùng tại doanh nghiệp đó. Khi đặt lại, các phiên của tài khoản quản lý đó bị đăng xuất. **Bảo mật tài khoản** hiển thị tên và email đang đăng nhập, đổi mật khẩu và thu hồi phiên của chính tài khoản đó. Phiên đang bật chế độ Nhân viên chỉ thao tác tại quầy.
- **Kho hàng** ở chi nhánh bán lẻ hiển thị số tồn và giá nhập bình quân của từng mặt hàng. Kết quả kiểm kê hiển thị hụt, dư hoặc khớp tồn. **Báo cáo → Xuất kho và kiểm kê** tính chênh lệch theo giá lưu lúc kiểm kê. Nếu thiếu giá đó, báo cáo dùng giá nhập bình quân hiện tại để ước tính và ghi rõ phần chưa có giá. Trong **Lịch sử**, dùng **Sửa số đếm** cho lần kiểm kê gần nhất. Hệ thống ghi điều chỉnh tồn và giữ các lượt nhập, xuất sau kiểm kê.
- Dùng **Danh mục hàng kho** trong **Quản lý doanh nghiệp → Nhập hàng** để sửa thông tin mặt hàng.
- **Nhập hàng** ghi số lượng, giá, thuế và hạn sử dụng của từng dòng. Một mặt hàng có thể nhập trên nhiều dòng với hạn khác nhau. **Kho hàng** và **Kho nguyên liệu** hiển thị số lượng theo từng hạn, cảnh báo dưới ngưỡng tồn và cảnh báo các lô sắp hết hạn trong 7 ngày. Quầy và chế biến ưu tiên lô còn hạn gần nhất. Khi kiểm kê, nhập số đếm cho từng hạn sử dụng.
- Với nhà hàng và quán nước, tạo nguyên liệu trong **Kho nguyên liệu**, rồi lập phiếu tại **Nhập hàng**. Phiếu nhập nguyên liệu có ô hạn sử dụng trên từng dòng. **Kiểm kê** và **Lịch sử** đối chiếu lượng đã xuất chế biến, tồn hệ thống và lượng đếm thực tế.
- Trong **Thực đơn**, món mới cần định lượng cho một phần từ kho của chi nhánh. Với món có sẵn, dùng **Định lượng tại chi nhánh** để thiết lập. Gọi món thường hoặc món ngoài gói buffet tại bàn và qua QR sẽ xuất nguyên liệu. Món trong gói buffet được ước tính giá vốn theo định lượng và không tự xuất kho. Hủy món trước khi bếp xử lý sẽ hoàn lượng đã xuất. Khi nâng cấp database, chạy `npm run db:indexes` để tạo chỉ mục định lượng và báo cáo.
- **Khuyến mãi** tạo chương trình giảm theo phần trăm hoặc số tiền cho toàn đơn hay các sản phẩm được chọn. Tại quầy bán lẻ và khi sửa đơn, danh sách **Khuyến mãi** hiện các ưu đãi đủ điều kiện và số tiền được giảm. Chọn một ưu đãi để áp dụng. Hệ thống kiểm tra lại sản phẩm, giá trị đơn tối thiểu và kỳ hiệu lực khi lưu. **Thuế và kế toán** cho đặt mức thuế bán lẻ tính trên số tiền sau giảm, xem tổng hợp hóa đơn và phiếu nhập theo kỳ, rồi tải CSV.
- **Sổ quỹ** tổng hợp giao dịch đã ghi nhận từ bán hàng, khách sạn, thu vé, hoàn tiền và nhập hàng. Có thể ghi khoản thu, chi khác và lọc theo tiền mặt hoặc chuyển khoản. **Xem hóa đơn** mở hàng hóa và lịch sử thanh toán ở giao dịch bán hàng hoặc hoàn tiền. **Xem phiếu nhập** mở từng mặt hàng, đơn giá, thuế và hạn sử dụng. **Xem phiếu chi** mở nội dung, số tiền, phương thức và thời gian của khoản chi ghi tay. **Xuất CSV** tải toàn bộ giao dịch của kỳ và bộ lọc đang chọn.
- **Thuế và kế toán** hiển thị số lượng phiếu thu gói hội viên và tổng tiền thực nhận theo kỳ, kể cả khi chi nhánh chỉ quản lý hội viên. Phiếu thu gói được tính theo ngày nhận tiền và xuất cùng báo cáo CSV. Các cột trước thuế và thuế để trống với phiếu thu gói vì số thuế chưa được tách trên chứng từ.
- Tại **Sổ quỹ**, lập phiếu chi theo ngày thực chi cho tiền nhân viên, thuê mặt bằng, điện nước và chi phí khác. Các khoản này xuất hiện theo nhóm trong **Thuế và kế toán**, báo cáo và CSV. **Lợi nhuận trước thuế** lấy lãi sau kiểm kê trừ chi phí vận hành trong kỳ.
- **Nhập hàng** xuất CSV các dòng của phiếu nhập theo kỳ. **Kho hàng** hoặc **Kho nguyên liệu** xuất tồn hiện tại theo lô hạn sử dụng và xuất lịch sử nhập, xuất, kiểm kê theo kỳ. **Giao dịch** xuất CSV đơn hàng, dòng hàng, hóa đơn, thanh toán và hoàn tiền theo kỳ của chi nhánh đang chọn.

## Phòng gym và bể bơi

1. Chủ doanh nghiệp chọn chi nhánh gym hoặc bể bơi trong **Quản lý doanh nghiệp**, mở **Gói tập** hoặc **Gói bơi** và bấm **Thêm gói**. Chọn **Theo tháng**, **Theo ngày** hoặc **Theo lượt**, nhập giá và số tháng, ngày hoặc lượt. Với gói lượt, có thể đặt hạn dùng theo tháng, ví dụ 12 lượt trong 2 tháng.
2. Tại **Tiếp đón → Check-in** hoặc **Tiếp đón → Hội viên**, lễ tân bấm **Thêm hội viên**, tải ảnh JPG, PNG hoặc WebP tối đa 4 MB và chọn gói của chi nhánh. Với gói có phí, chọn phương thức đã nhận tiền rồi xác nhận. Tiền vào **Sổ quỹ**, **Báo cáo** và doanh thu chi nhánh ở **Tổng quan**. Gói miễn phí chỉ cấp quyền sử dụng. Chủ doanh nghiệp có thể mở hồ sơ trong **Quản lý doanh nghiệp → Quản lý hội viên** để sửa thông tin, đổi ảnh, gia hạn hoặc liên kết mã check-in. Gia hạn gói có phí cũng ghi nhận tiền lúc xác nhận đã thu. Gia hạn cùng gói nối hạn hoặc cộng lượt còn lại. Gán gói khác thay gói hiện tại. Gói có hạn dùng đến hết ngày ghi trên hồ sơ theo giờ Việt Nam.
3. Chủ doanh nghiệp mở **Quản lý doanh nghiệp → Quản lý check-in** để bật các phương thức của từng phòng, cấu hình thiết bị và xem lịch sử. Trong hồ sơ hội viên, có thể liên kết mã thẻ tự đặt, mã vân tay và mã khuôn mặt từ máy nhận diện. Sau khi check-in, quầy và màn hình tự check-in hiển thị ngày đăng ký, ngày đến tập đầu tiên, số ngày đã đến tập và số ngày hoặc lượt còn lại của gói. Mỗi ngày có check-in được tính một lần theo giờ Việt Nam. Thời hạn còn lại tính cả hôm nay. Với gói lượt, số lượt hiển thị sau khi đã trừ lượt vừa vào. **Lịch sử vào** lưu thông tin tại thời điểm check-in.
4. Ảnh hồ sơ hiện trong **Danh sách hội viên** và bên cạnh lượt check-in. Chọn **Xem thông tin** trong **Lượt vào gần đây** hoặc **Lịch sử vào** để xem ảnh, mã, số điện thoại, gói và thông tin của lượt vào. Màn hình tự check-in hiện ảnh của lượt vừa thành công trong vài giây.
5. Với gói hiện tại có giá đã lưu và khoản thu chưa có trong Sổ quỹ, mở hồ sơ rồi chọn **Ghi nhận tiền đã thu cho gói hiện tại**. Chọn phương thức và ngày giờ thực nhận để khoản thu vào đúng kỳ. Chủ cửa hàng và quản lý có thể bấm **Xoá** để gỡ hồ sơ và các mã đã liên kết. Lịch sử check-in và phiếu thu đã ghi nhận vẫn được lưu.

Trong hồ sơ quản lý, lọc theo tình trạng gói, xem lịch sử check-in và thu phí, hoặc bảo lưu gói đến ngày mở lại. Bảo lưu chặn check-in trong khoảng đã chọn và cộng bù vào gói có hạn. Mở lại trước lịch thì chỉ cộng những ngày đã nghỉ. Bỏ chỗ các lớp trùng kỳ trước khi bảo lưu.

Tại **Tiếp đón → Lịch lớp**, chủ hoặc quản lý tạo lớp, chọn giờ và số chỗ. Lễ tân tìm hội viên để giữ chỗ. Hệ thống kiểm tra hiệu lực gói theo ngày diễn ra và chặn trùng lịch. Khi lớp đầy, người đăng ký vào danh sách chờ. Nếu có người bỏ chỗ, hội viên đủ điều kiện đăng ký chờ sớm nhất được chuyển vào lớp. Lễ tân có thể điểm danh từ giờ bắt đầu lớp. Số lượt gói do quy trình check-in tại cửa quản lý.

Khi nâng cấp database từ bản trước, chạy `npm run db:indexes` để tạo chỉ mục cho dữ liệu hội viên và lịch lớp.

### Check-in tự động tại cửa

Trong **Quản lý check-in → Màn hình tự check-in tại cửa**, tạo link rồi mở link theo phương thức trên trình duyệt tại cửa. Máy quét thẻ ở chế độ bàn phím điền mã và gửi phím Enter để tự check-in. Màn hình có thể dùng cả mã hội viên nếu phòng bật phương thức này. Trình duyệt lưu thiết lập cho lần mở sau. Khi cấp link mới, mở lại link ở các màn hình đang dùng.

Với máy vân tay hoặc khuôn mặt, đăng ký nhận diện trên máy, liên kết mã hồ sơ trong JUEE POS, rồi dùng bộ tích hợp của thiết bị gửi mã ngay sau khi nhận diện thành công. JUEE POS lưu mã liên kết của máy. Mẫu vân tay và ảnh khuôn mặt do thiết bị quản lý.

**Quản lý check-in → Kết nối máy check-in** cấp khóa và hiển thị đường dẫn cho chi nhánh. Bộ tích hợp gọi `POST` bằng HTTPS với `Authorization: Bearer <khóa thiết bị>`, `Idempotency-Key` là mã riêng của lần check-in (16–100 ký tự chữ, số, gạch ngang hoặc gạch dưới), và `Content-Type: application/json`. Khi gửi lại cùng sự kiện, giữ nguyên khóa chống trùng và nội dung. Payload gồm `method` (`CARD`, `FINGERPRINT` hoặc `FACE`) và `code` là mã đã liên kết. Tạo khóa thay thế hoặc thu hồi sẽ vô hiệu hóa khóa cũ.

```json
{ "method": "FINGERPRINT", "code": "000125" }
```

## Nhà nghỉ / Khách sạn và Thu vé

- Chọn mô hình khi đăng ký cửa hàng hoặc khi tạo chi nhánh trong **Quản lý doanh nghiệp → Chi nhánh**.
- Với **Nhà nghỉ / Khách sạn**, vào **Quản lý doanh nghiệp → Phòng và gói lưu trú** để đặt giá giờ đầu, giá mỗi giờ tiếp theo và giá theo đêm cho từng phòng. Giá giờ tiếp theo cũng là mức tính quá giờ. Ô trống dùng giá giờ đầu, hoặc 0 ₫ nếu phòng chưa có giá giờ đầu.
- Tại quầy, chọn **Theo giờ → Nhận phòng ngay**. Hệ thống ghi giờ nhận tự động, tính tối thiểu một giờ và làm tròn giờ lẻ lên. Lượt theo giờ cũ có số giờ cố định giữ giá đã đặt.
- Lượt theo đêm có hạn trả lúc **12:00 giờ Việt Nam** vào ngày đã chọn. Lượt theo gói hết hạn vào giờ nhận đã đặt cộng thời lượng gói. Khi khách vẫn ở sau hạn, **Sơ đồ phòng**, **Đặt phòng** và **Lịch phòng** hiện **Quá giờ**. Phí quá giờ cộng theo giá giờ tiếp theo đã lưu cùng đặt phòng. Khi thu tiền, hệ thống lưu số giờ, phí quá giờ và thời điểm trả phòng.
- Trong **Chi tiết tiền phòng**, lễ tân ghi phụ phí như minibar và dịch vụ. Chủ hoặc quản lý có thể bỏ phụ phí ghi sai trước khi thu tiền. Các khoản này cộng vào phiếu trả phòng. Sau khi thu, có thể in phiếu. Phòng chuyển sang **Chờ dọn**, rồi về **Sẵn sàng** khi bấm **Dọn xong**.
- Với **Thu vé**, chủ hoặc quản lý cấu hình **Loại vé**, giá thường, giá mua sớm, số lượng tối đa, thời gian mở bán và khung giờ vào cửa. Khi mua nhiều suất cùng loại, chọn **Vé chung** để in một hóa đơn kèm một mã QR cho cả nhóm, hoặc **Vé riêng** để mỗi khách có một mã QR. Mỗi mã quét được một lần trong khung giờ đã lưu. Tìm lượt bán bằng tên khách, số điện thoại hoặc mã vé và in lại từ lịch sử.
- Chủ hoặc quản lý có thể ghi hoàn toàn bộ lượt bán nếu tất cả vé còn chưa soát. Hệ thống vô hiệu mã, mở lại số lượng được bán và ghi khoản chi với lý do. Quầy ghi nhận tiền mặt hoặc xác nhận giao dịch chuyển khoản đã thực hiện. Doanh thu và sổ quỹ dùng thời điểm thu, chi thực tế. **Thuế và kế toán** có thêm dòng thu phòng, thu vé và chi hoàn vé.

Khi nâng cấp từ bản trước, chạy `npm run db:indexes` để tạo chỉ mục phòng, đặt chỗ và vé.

### Bán hàng hóa ở chi nhánh dịch vụ

Phòng gym, bể bơi, khách sạn và điểm thu vé có nhóm **Bán hàng hóa**. Quản lý tạo mặt hàng tại **Quản lý doanh nghiệp → Nhập hàng → Danh mục hàng kho**, lập phiếu nhập rồi chọn **Sản phẩm → Đăng bán từ kho** để đặt giá. Mặt hàng được đăng cho chi nhánh đang chọn.

Lễ tân vào **Bán đồ tại quầy** để thêm sản phẩm và thu tiền mặt hoặc tạo đơn chờ thanh toán. Muốn tiếp tục thu tiền, mở **Đơn bán hàng** hoặc **Thanh toán hàng hóa**. Đơn ghi nhận lượng xuất kho theo lô còn hạn. Hóa đơn bán hàng và các phiếu thu gói tập, tiền phòng, tiền vé được tổng hợp riêng trong **Thuế và kế toán**.

## Kiểm tra

```sh
npm test
npm run build
TEST_DATABASE_URL="$(node --env-file=backend/.env -e 'const uri = new URL(process.env.MONGODB_URI || process.env.DATABASE_URL); uri.pathname = "/juee_test"; console.log(uri.href)')" npm run test:integration
```

Bài tích hợp tự chuẩn bị index và gói mặc định, yêu cầu tên database kết thúc bằng `_test`. Hãy thử gửi email thật bằng SMTP của bạn và quét mã QR bằng điện thoại trước khi triển khai. Khi đưa ra internet, dùng HTTPS, chỉ cấu hình `TRUST_PROXY_HOPS` theo đúng proxy tin cậy và thiết lập sao lưu MongoDB định kỳ.

### Đối soát chuyển khoản với SePay

Cấu hình webhook JSON **Có tiền vào** trong tài khoản SePay với phương thức **API Key**. Đặt cùng khóa API ngẫu nhiên, tối thiểu 32 ký tự, vào `SEPAY_WEBHOOK_API_KEY`. URL nhận sự kiện là `https://<tên-miền>/api/v1/webhooks/sepay`. Khi mã trong nội dung, tài khoản nhận và số tiền đều khớp với QR đang hiệu lực, JUEE ghi nhận thu tiền. Giao dịch đã nhận được xử lý một lần theo mã giao dịch SePay. Các giao dịch nhận diện được chi nhánh nhưng cần đối chiếu thêm xuất hiện ở mục **Thanh toán**. Dùng tài khoản và số tiền kiểm thử của bạn trước khi bật đối soát thực tế.

[Tài liệu webhook SePay](https://docs.sepay.vn/tich-hop-webhooks.html)

### Đối soát thuê bao cũ

JUEE POS không phát hành yêu cầu thanh toán thuê bao mới. Webhook `/api/v1/webhooks/sepay/subscriptions` vẫn xử lý các giao dịch đã phát sinh nếu đã được cấu hình. Kiểm tra sao kê và các khoản đang chờ tại **Super Admin → Thuê bao**.
