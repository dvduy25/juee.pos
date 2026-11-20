# JUEE POS Super Admin

Ứng dụng quản trị dùng backend JUEE POS.

## Chạy trên máy

Sao chép `.env.example` thành `.env.local` và đặt `API_ORIGIN` thành địa chỉ backend đang chạy. Backend cần cho phép `ADMIN_WEB_ORIGIN=http://127.0.0.1:3002`.

```sh
npm ci
npm run dev
```

Mở [trang đăng nhập](http://127.0.0.1:3002/login). Dùng tài khoản quản trị đã được cấp quyền qua CLI và mã Authenticator.

## Triển khai riêng

Trong thư mục này, dựng image với địa chỉ API thực tế.

```sh
docker build --build-arg API_ORIGIN=https://api.example.com -t juee-admin .
docker run --rm -p 3002:3002 juee-admin
```

Đặt `ADMIN_WEB_ORIGIN=https://admin.example.com` ở backend và trỏ tên miền quản trị qua HTTPS đến cổng 3002. Tên miền quản trị cần khác tên miền web khách hàng.
