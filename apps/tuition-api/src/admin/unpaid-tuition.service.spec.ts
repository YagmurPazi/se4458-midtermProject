import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrisma } from '../testing/mock-prisma';
import { UnpaidQueryDto } from './admin.dto';
import { UnpaidTuitionService } from './unpaid-tuition.service';

const D = (value: string) => new Prisma.Decimal(value);

function query(overrides: Partial<UnpaidQueryDto> = {}): UnpaidQueryDto {
  return { term: '2026-FALL', page: 1, pageSize: 20, sortBy: 'balance', sortOrder: 'desc', ...overrides };
}

describe('UnpaidTuitionService.list', () => {
  const prisma = createMockPrisma();
  const service = new UnpaidTuitionService(prisma as unknown as PrismaService);
  const row = {
    studentNo: '20230003',
    fullName: 'Deniz Kaya',
    term: '2026-FALL',
    tuitionTotal: D('3000.00'),
    paidAmount: D('500.00'),
    balance: D('2500.00'),
    currency: 'USD',
  };

  beforeEach(() => jest.resetAllMocks());

  it('returns a page with paging metadata and money as numbers', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 45n }]).mockResolvedValueOnce([row]);

    const result = await service.list(query({ page: 2, pageSize: 20 }));

    expect(result).toEqual({
      term: '2026-FALL',
      page: 2,
      pageSize: 20,
      totalItems: 45,
      totalPages: 3,
      sortBy: 'balance',
      sortOrder: 'desc',
      items: [{ ...row, tuitionTotal: 3000, paidAmount: 500, balance: 2500 }],
    });
  });

  it('orders by the requested column and direction, with studentNo as tie-break, and pages with LIMIT/OFFSET', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 45n }]).mockResolvedValueOnce([row]);

    await service.list(query({ page: 3, pageSize: 10, sortBy: 'studentNo', sortOrder: 'asc' }));

    const select = prisma.$queryRaw.mock.calls[1][0] as Prisma.Sql;
    expect(select.sql).toContain('ORDER BY s.student_no ASC, s.student_no ASC');
    expect(select.sql).toContain('HAVING t.amount - COALESCE(SUM(p.amount), 0) > 0');
    expect(select.values).toEqual(['2026-FALL', 10, 20]);
  });

  it('defaults to balance descending', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 1n }]).mockResolvedValueOnce([row]);

    await service.list(query());

    expect((prisma.$queryRaw.mock.calls[1][0] as Prisma.Sql).sql).toContain('ORDER BY "balance" DESC, s.student_no ASC');
  });

  it('returns an empty page 1 with totalPages 0 when nothing is unpaid', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 0n }]);

    const result = await service.list(query());

    expect(result).toMatchObject({ items: [], totalItems: 0, totalPages: 0, page: 1 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects page 2 when everything fits on one page (PAGE_OUT_OF_RANGE)', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 7n }]);

    await expect(service.list(query({ page: 2 }))).rejects.toMatchObject({ code: 'PAGE_OUT_OF_RANGE' });
  });

  it('rejects page 2 when the result is empty', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 0n }]);

    await expect(service.list(query({ page: 2 }))).rejects.toMatchObject({ code: 'PAGE_OUT_OF_RANGE' });
  });
});
