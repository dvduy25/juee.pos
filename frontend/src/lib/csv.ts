export function downloadFile(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(rows: (string | number)[][], name: string) {
  const encode = (cell: string | number) => {
    if (typeof cell === 'number') return String(cell);
    const safe = /^[\p{C}\s]*[=+@-]|^[\t\r\n]/u.test(cell) ? `'${cell}` : cell;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  downloadFile(new Blob(['\uFEFF', rows.map(row => row.map(encode).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${name}.csv`);
}
