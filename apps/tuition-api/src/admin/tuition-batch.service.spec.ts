import { Prisma } from '@prisma/client';
import { AppException } from '../common/app.exception';
import { TuitionAdminService } from './tuition-admin.service';
import { TuitionBatchService } from './tuition-batch.service';

const HEADER = 'studentNo,term,amount,currency';

describe('TuitionBatchService.importCsv', () => {
  const upsert = jest.fn();
  const service = new TuitionBatchService({ upsert } as unknown as TuitionAdminService);
  const csv = (...lines: string[]) => Buffer.from(lines.join('\n'));

  beforeEach(() => {
    jest.resetAllMocks();
    upsert.mockResolvedValue({ status: 'CREATED' });
  });

  it('processes rows independently and reports mixed results with real line numbers', async () => {
    upsert.mockImplementation(({ studentNo }: { studentNo: string }) => {
      if (studentNo === '99999999') {
        throw new AppException(404, 'STUDENT_NOT_FOUND', 'missing');
      }
      return Promise.resolve({ status: studentNo === '20230002' ? 'UPDATED' : 'CREATED' });
    });

    const result = await service.importCsv(
      csv(HEADER, '20230001,2026-FALL,3000.00,USD', '', '20230002,2026-FALL,2500,USD', '99999999,2026-FALL,100,USD'),
    );

    expect(result).toEqual({
      totalRows: 3,
      succeeded: 2,
      failed: 1,
      results: [
        { row: 2, studentNo: '20230001', term: '2026-FALL', status: 'CREATED' },
        { row: 4, studentNo: '20230002', term: '2026-FALL', status: 'UPDATED' },
        { row: 5, studentNo: '99999999', term: '2026-FALL', status: 'FAILED', error: 'STUDENT_NOT_FOUND' },
      ],
    });
    expect(upsert).toHaveBeenCalledWith({
      studentNo: '20230001',
      term: '2026-FALL',
      amount: new Prisma.Decimal('3000.00'),
    });
  });

  it('flags a repeated studentNo + term as DUPLICATE_IN_FILE and keeps the first', async () => {
    const result = await service.importCsv(
      csv(HEADER, '20230001,2026-FALL,3000,USD', '20230001,2026-FALL,4000,USD'),
    );

    expect(result.results[1]).toMatchObject({ row: 3, status: 'FAILED', error: 'DUPLICATE_IN_FILE' });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['bad studentNo', 'abc,2026-FALL,3000,USD'],
    ['bad term', '20230001,2026-WINTER,3000,USD'],
    ['three decimals', '20230001,2026-FALL,3000.123,USD'],
    ['zero amount', '20230001,2026-FALL,0,USD'],
    ['amount above 1,000,000', '20230001,2026-FALL,1000000.01,USD'],
    ['wrong currency', '20230001,2026-FALL,3000,EUR'],
    ['too few columns', '20230001,2026-FALL,3000'],
    ['too many columns', '20230001,2026-FALL,3000,USD,x'],
  ])('rejects a row with %s as VALIDATION_ERROR without touching the database', async (_name, row) => {
    const result = await service.importCsv(csv(HEADER, row));

    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({ status: 'FAILED', error: 'VALIDATION_ERROR' });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('accepts a UTF-8 BOM, CRLF line endings and spaces around values', async () => {
    const file = Buffer.from(`\uFEFF${HEADER}\r\n 20230001 , 2026-FALL , 3000.50 , USD \r\n`);

    const result = await service.importCsv(file);

    expect(result.succeeded).toBe(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ amount: new Prisma.Decimal('3000.50') }));
  });

  it.each([
    ['a wrong header', 'studentNo,term,amount'],
    ['a different column order', 'term,studentNo,amount,currency'],
  ])('rejects the whole file for %s', async (_name, header) => {
    await expect(service.importCsv(csv(header, '20230001,2026-FALL,3000,USD'))).rejects.toMatchObject({
      code: 'INVALID_CSV_HEADER',
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects an empty file as INVALID_CSV_HEADER', async () => {
    await expect(service.importCsv(Buffer.alloc(0))).rejects.toMatchObject({ code: 'INVALID_CSV_HEADER' });
  });

  it('rejects more than 1,000 data rows as FILE_TOO_LARGE', async () => {
    const rows = Array.from({ length: 1001 }, () => '20230001,2026-FALL,3000,USD');

    await expect(service.importCsv(csv(HEADER, ...rows))).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('accepts exactly 1,000 data rows', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `20230001,${2000 + i}-FALL,3000,USD`);

    const result = await service.importCsv(csv(HEADER, ...rows));

    expect(result.totalRows).toBe(1000);
  });
});
