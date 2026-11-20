let accessToken = '';
let refreshPending: Promise<boolean> | undefined;

export function setToken(value: string) {
  accessToken = value;
}

export async function restore() {
  if (!refreshPending) {
    refreshPending = fetch('/api/v1/admin-auth/refresh', { method: 'POST', credentials: 'same-origin' })
      .then(async response => {
        if (response.status === 401) {
          accessToken = '';
          return false;
        }
        if (!response.ok) throw await responseError(response);
        accessToken = (await response.json()).accessToken;
        return true;
      }).finally(() => { refreshPending = undefined; });
  }
  return refreshPending;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterSeconds?: number) { super(message); }
}

async function responseError(response: Response) {
  const result = await response.json().catch(() => null);
  const message = Array.isArray(result?.message) ? result.message.join(', ') :
    typeof result?.message === 'string' ? result.message : '';
  if (response.status === 413 && message === 'File too large') return new ApiError(413, 'Tệp ảnh vượt quá 4 MB.');
  if (response.status === 429) {
    const header = response.headers.get('Retry-After');
    const seconds = header && /^\d+$/.test(header) ? Number(header) : undefined;
    const wait = seconds && Number.isSafeInteger(seconds) ? seconds : undefined;
    const when = !wait ? '' : wait < 60 ? ` sau ${wait} giây` : ` sau khoảng ${Math.ceil(wait / 60)} phút`;
    return new ApiError(429, `${message || 'Bạn đã gửi quá nhiều yêu cầu.'} Vui lòng thử lại${when}.`, wait);
  }
  const forbidden = response.status === 403 && (!message || message === 'Forbidden');
  return new ApiError(response.status, forbidden ? 'Bạn không có quyền thực hiện thao tác này.' :
    response.status === 503 && message ? message : response.status >= 500 ? 'Không kết nối được dịch vụ. Vui lòng thử lại.' :
    message || 'Yêu cầu chưa thành công.');
}

async function requestApi(path: string, method: string, data?: unknown, extraHeaders?: Record<string, string>) {
  const multipart = data instanceof FormData;
  const request = () => fetch('/api/v1' + path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(data === undefined || multipart ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
    body: multipart ? data : JSON.stringify(data),
  });
  let response = await request();
  const needsSession = /^\/platform(\/|\?|$)/.test(path) || path === '/admin-auth/me';
  if (response.status === 401 && needsSession && await restore()) response = await request();
  if (!response.ok) throw await responseError(response);
  return response;
}

export async function api<T>(path: string, method = 'GET', data?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const response = await requestApi(path, method, data, extraHeaders);
  return response.json().catch(() => ({}));
}

