#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || ( $# -eq 2 && "$2" != '--existing' ) ]]; then
  printf 'Cách dùng: npm run admin:setup -- <email> [--existing]\n' >&2
  exit 1
fi

if [[ ! -t 0 || ! -t 1 ]]; then
  printf 'Hãy chạy lệnh trong Terminal tương tác để nhập mật khẩu an toàn.\n' >&2
  exit 1
fi

current_password=''
if [[ $# -eq 2 ]]; then
  IFS= read -r -s -p 'Mật khẩu hiện tại của tài khoản: ' current_password
  printf '\n'
  if [[ -z "$current_password" ]]; then
    printf 'Hãy nhập mật khẩu hiện tại của tài khoản.\n' >&2
    exit 1
  fi
fi

IFS= read -r -s -p 'Mật khẩu Super Admin mới (16–128 ký tự): ' password
printf '\n'
if [[ ${#password} -lt 16 || ${#password} -gt 128 ]]; then
  printf 'Mật khẩu cần có từ 16 đến 128 ký tự.\n' >&2
  exit 1
fi

IFS= read -r -s -p 'Nhập lại mật khẩu: ' confirm
printf '\n'
if [[ "$password" != "$confirm" ]]; then
  printf 'Hai mật khẩu chưa khớp.\n' >&2
  exit 1
fi
unset confirm

secret="$(node -e 'process.stdout.write(require("otplib").authenticator.generateSecret(20))')"
BOOTSTRAP_ADMIN_EMAIL="$1" BOOTSTRAP_ADMIN_PASSWORD="$password" \
  BOOTSTRAP_ADMIN_CURRENT_PASSWORD="$current_password" BOOTSTRAP_ADMIN_TOTP="$secret" npm run db:seed
unset password current_password

printf '\nĐã cấp quyền Super Admin cho %s.\n' "$1"
printf 'Trong ứng dụng Authenticator, chọn nhập khóa thiết lập và loại Theo thời gian.\n'
printf 'Khóa thiết lập (chỉ lưu trong ứng dụng Authenticator): %s\n' "$secret"
printf 'Mở http://localhost:3000/super-admin rồi nhập mã 6 số hiện tại trong ứng dụng.\n'
