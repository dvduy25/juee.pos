// The QR encoder exposes the same matrix used by its terminal renderer.
const QRCode = require('qrcode-terminal/vendor/QRCode') as new (version: number, level: number) => {
  addData(value: string): void; make(): void; getModuleCount(): number; isDark(row: number, column: number): boolean;
};

export function qrImage(payload: string) {
  const matrix = new QRCode(-1, 0);
  matrix.addData(payload);
  matrix.make();
  const modules = matrix.getModuleCount();
  const size = modules + 8;
  const paths: string[] = [];
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (matrix.isDark(y, x)) paths.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${size}v${size}H0z"/><path d="${paths.join('')}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
