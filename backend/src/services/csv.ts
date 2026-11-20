import { StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';

type CsvCell = string | number;
export const csvDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'medium' });

export function csvFile(name: string, header: string[], rows: AsyncIterable<CsvCell[]>) {
  function encode(cells: CsvCell[]) {
    return cells.map(cell => {
      if (typeof cell === 'number') return String(cell);
      const text = /^[\p{C}\s]*[=+@-]|^[\t\r\n]/u.test(cell) ? `'${cell}` : cell;
      return `"${text.replaceAll('"', '""')}"`;
    }).join(',') + '\r\n';
  }
  async function* content() {
    const iterator = rows[Symbol.asyncIterator]();
    try {
      let row = await iterator.next();
      yield '\uFEFF' + encode(header);
      while (!row.done) {
        yield encode(row.value);
        row = await iterator.next();
      }
    } finally {
      await iterator.return?.();
    }
  }
  return new StreamableFile(Readable.from(content()), {
    type: 'text/csv; charset=utf-8', disposition: `attachment; filename="${name}.csv"`,
  });
}
