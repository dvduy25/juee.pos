export function currentPosition() {
  if (!window.isSecureContext || !navigator.geolocation) {
    return Promise.reject(new Error('Mở trang bằng HTTPS để sử dụng vị trí trên thiết bị này.'));
  }
  return new Promise<{ latitude: number; longitude: number; accuracy: number; measuredAt: number }>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(({ coords, timestamp }) => {
      resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, measuredAt: Math.round(timestamp) });
    }, error => {
      const message = error.code === 1 ? 'Hãy cấp quyền vị trí chính xác cho trang này rồi thử lại.' :
        error.code === 3 ? 'Thiết bị chưa lấy được vị trí kịp thời. Hãy bật vị trí và thử lại.' :
          'Thiết bị chưa xác định được vị trí. Hãy bật vị trí chính xác và thử lại.';
      reject(new Error(message));
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 });
  });
}
