let accessToken = '';
let refreshPending: Promise<boolean> | undefined;

export function setToken(value: string) {
  accessToken = value;
}

export async function restore() {
  if (!refreshPending) {
    refreshPending = fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' })
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

async function responseError(response: Response, inventoryAi = false) {
  const result = await response.json().catch(() => null);
  const message = Array.isArray(result?.message) ? result.message.join(', ') :
    typeof result?.message === 'string' ? result.message : '';
  if (response.status === 413 && message === 'File too large') return new ApiError(413, 'Tệp ảnh vượt quá 4 MB.');
  if (inventoryAi && (response.status === 502 || response.status === 504) &&
    result?.code === 'INVENTORY_AI_UPSTREAM' && message) return new ApiError(response.status, message);
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
  const inventoryAi = method === 'POST' && /^\/tenants\/[a-f0-9]{24}\/branches\/[a-f0-9]{24}\/warehouse\/ai\/extract$/i.test(path);
  const directOrigin = inventoryAi ? process.env.NEXT_PUBLIC_INVENTORY_AI_ORIGIN : '';
  async function request() {
    try {
      return await fetch((directOrigin || '') + '/api/v1' + path, {
        method, credentials: 'same-origin', cache: 'no-store', ...(directOrigin ? { redirect: 'error' } : {}),
        headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...(data === undefined || multipart ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
        body: multipart ? data : JSON.stringify(data),
      });
    } catch (error) {
      if (inventoryAi) throw new ApiError(0, 'Không kết nối được máy chủ đọc chứng từ. Hãy thử lại.');
      throw error;
    }
  }
  let response = await request();
  const needsSession = /^\/tenants(\/|\?|$)/.test(path) || /^\/auth\/(me|sessions|change-password|set-initial-password|work-mode|branch-access)(\/|\?|$)/.test(path);
  if (response.status === 401 && needsSession && await restore()) response = await request();
  if (!response.ok) throw await responseError(response, inventoryAi);
  return response;
}

export async function api<T>(path: string, method = 'GET', data?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const response = await requestApi(path, method, data, extraHeaders);
  return response.json().catch(() => ({}));
}

export async function apiBlob(path: string, headers?: Record<string, string>): Promise<Blob> {
  return (await requestApi(path, 'GET', undefined, headers)).blob();
}

export async function eventStream(path: string, signal: AbortSignal, lastEventId?: string) {
  const request = () => fetch('/api/v1' + path, {
    signal, cache: 'no-store', credentials: 'same-origin',
    headers: { Authorization: `Bearer ${accessToken}`, ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) },
  });
  let response = await request();
  if (response.status === 401 && await restore()) response = await request();
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new ApiError(response.status, 'Không thể theo dõi thay đổi.');
  return response.body;
}

export function requestKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
}
