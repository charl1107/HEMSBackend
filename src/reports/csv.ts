export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  let text: string;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    text = String(value);
  } else {
    text = JSON.stringify(value) ?? '';
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
