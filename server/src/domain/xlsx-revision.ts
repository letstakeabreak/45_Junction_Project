import ExcelJS from "exceljs";
import { DomainError } from "./errors.js";
import type { CueRow } from "./types.js";

export function cellText(cell: ExcelJS.Cell): string {
  try {
    return cell.text ?? "";
  } catch {
    // Some real-world XLSX files contain a merged cell whose master was removed.
    // Excel renders that cell as blank, while ExcelJS throws from Cell.text.
    return cell.value == null ? "" : String(cell.value);
  }
}

function headerRow(worksheet: ExcelJS.Worksheet): number {
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    let populated = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cellText(cell).trim() !== "") populated = true;
    });
    if (populated) {
      return rowNumber;
    }
  }
  return 1;
}

function columnKeys(worksheet: ExcelJS.Worksheet, rowNumber: number): Map<number, string> {
  const keys = new Map<number, string>();
  const used = new Set<string>();
  const row = worksheet.getRow(rowNumber);
  for (let column = 1; column <= worksheet.columnCount; column += 1) {
    const raw = cellText(row.getCell(column)).trim();
    const base = raw || worksheet.getColumn(column).letter;
    let key = base;
    let suffix = 2;
    while (used.has(key)) {
      key = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(key);
    keys.set(column, key);
  }
  return keys;
}

export async function cueRowsFromXlsx(bytes: Uint8Array): Promise<CueRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const rows: CueRow[] = [];
  workbook.worksheets.forEach((worksheet, sheetIndex) => {
    const header = headerRow(worksheet);
    const keys = columnKeys(worksheet, header);
    for (let rowNumber = header + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const worksheetRow = worksheet.getRow(rowNumber);
      if (!worksheetRow.hasValues) continue;
      const values: CueRow = { id: `t_${sheetIndex}_r_${rowNumber}` };
      for (const [column, key] of keys) values[key] = cellText(worksheetRow.getCell(column));
      rows.push(values);
    }
  });
  if (rows.length === 0) {
    throw new DomainError(422, "CONTRACT_VIOLATION", "MASTER_CUE XLSX has no data rows.");
  }
  return rows;
}

export async function exportXlsxRevision(
  bytes: Uint8Array,
  baseRows: CueRow[],
  revisedRows: CueRow[],
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const baseById = new Map(baseRows.map((row) => [row.id, row]));
  const revisedIds = new Set(revisedRows.map((row) => row.id));
  const positions = new Map<string, { sheet: number; row: number }>();
  for (const row of baseRows) {
    const match = /^t_(\d+)_r_(\d+)$/.exec(row.id);
    if (match) positions.set(row.id, { sheet: Number(match[1]), row: Number(match[2]) });
  }

  const deleted = baseRows
    .filter((row) => !revisedIds.has(row.id))
    .map((row) => ({ id: row.id, position: positions.get(row.id) }))
    .filter((item): item is { id: string; position: { sheet: number; row: number } } => Boolean(item.position))
    .sort((left, right) => right.position.sheet - left.position.sheet || right.position.row - left.position.row);
  for (const item of deleted) {
    const worksheet = workbook.worksheets[item.position.sheet];
    if (!worksheet) continue;
    worksheet.spliceRows(item.position.row, 1);
    positions.delete(item.id);
    for (const position of positions.values()) {
      if (position.sheet === item.position.sheet && position.row > item.position.row) position.row -= 1;
    }
  }

  for (let index = 0; index < revisedRows.length; index += 1) {
    const row = revisedRows[index];
    if (!row) continue;
    if (baseById.has(row.id)) continue;
    const match = /^t_(\d+)_n_[a-zA-Z0-9_-]+$/.exec(row.id);
    if (!match) continue;
    const sheet = Number(match[1]);
    let anchor: { sheet: number; row: number } | undefined;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const previousRow = revisedRows[previous];
      if (!previousRow) continue;
      const position = positions.get(previousRow.id);
      if (position?.sheet === sheet) {
        anchor = position;
        break;
      }
    }
    const worksheet = workbook.worksheets[sheet];
    if (!worksheet || !anchor) continue;
    const insertedAt = anchor.row + 1;
    worksheet.spliceRows(insertedAt, 0, []);
    for (const position of positions.values()) {
      if (position.sheet === sheet && position.row >= insertedAt) position.row += 1;
    }
    positions.set(row.id, { sheet, row: insertedAt });
    const keys = columnKeys(worksheet, headerRow(worksheet));
    for (const [column, key] of keys) worksheet.getRow(insertedAt).getCell(column).value = row[key] ?? "";
  }

  for (const revised of revisedRows) {
    const position = positions.get(revised.id);
    const base = baseById.get(revised.id);
    if (!position || !base) continue;
    const worksheet = workbook.worksheets[position.sheet];
    if (!worksheet) continue;
    const keys = columnKeys(worksheet, headerRow(worksheet));
    for (const [column, key] of keys) {
      if (!(key in revised) || revised[key] === base[key]) continue;
      worksheet.getRow(position.row).getCell(column).value = revised[key];
    }
  }

  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
