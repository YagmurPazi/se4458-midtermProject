import { Prisma } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { AppException } from '../common/app.exception';
import { MAX_AMOUNT, STUDENT_NO_PATTERN, TERM_PATTERN } from '../common/validation';
import { CURRENCY } from '../common/money';

export const CSV_HEADER = ['studentNo', 'term', 'amount', 'currency'];
export const MAX_DATA_ROWS = 1000;

const AMOUNT_PATTERN = /^\d{1,7}(\.\d{1,2})?$/;

export interface CsvRow {
  /** Line number in the file; the header is line 1. */
  line: number;
  fields: string[];
}

export interface ValidRow {
  studentNo: string;
  term: string;
  amount: Prisma.Decimal;
}

/** Parses the file and checks the header and the row limit; row contents are validated later. */
export function parseTuitionCsv(content: Buffer): CsvRow[] {
  let records: { record: string[]; info: { lines: number } }[];
  try {
    records = parse(content, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      info: true,
    }) as unknown as typeof records;
  } catch {
    throw new AppException(400, 'VALIDATION_ERROR', 'The file is not valid CSV.');
  }

  const [header, ...rows] = records;
  if (!header || header.record.join(',') !== CSV_HEADER.join(',')) {
    throw new AppException(400, 'INVALID_CSV_HEADER', `The header row must be exactly ${CSV_HEADER.join(',')}.`);
  }
  if (rows.length > MAX_DATA_ROWS) {
    throw new AppException(400, 'FILE_TOO_LARGE', `The file has more than ${MAX_DATA_ROWS} data rows.`);
  }
  return rows.map(({ record, info }) => ({ line: info.lines, fields: record }));
}

/** Returns the typed row, or null when any column is invalid (including a wrong column count). */
export function validateRow(fields: string[]): ValidRow | null {
  if (fields.length !== CSV_HEADER.length) {
    return null;
  }
  const [studentNo, term, amountText, currency] = fields;
  if (
    !STUDENT_NO_PATTERN.test(studentNo) ||
    !TERM_PATTERN.test(term) ||
    !AMOUNT_PATTERN.test(amountText) ||
    currency !== CURRENCY
  ) {
    return null;
  }
  const amount = new Prisma.Decimal(amountText);
  if (amount.lte(0) || amount.gt(MAX_AMOUNT)) {
    return null;
  }
  return { studentNo, term, amount };
}
