import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrisma } from '../testing/mock-prisma';
import { TuitionQueryService } from './tuition-query.service';

const D = (value: string) => new Prisma.Decimal(value);

describe('TuitionQueryService', () => {
  const prisma = createMockPrisma();
  const service = new TuitionQueryService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.student.findUnique.mockResolvedValue({ id: 's1' });
  });

  it('returns the overall balance with terms sorted chronologically', async () => {
    prisma.tuition.findMany.mockResolvedValue([
      { term: '2027-SPRING', amount: D('3000.00'), payments: [] },
      { term: '2026-FALL', amount: D('3000.00'), payments: [{ amount: D('1000.10') }, { amount: D('499.90') }] },
      { term: '2026-SUMMER', amount: D('800.50'), payments: [] },
    ]);

    const result = await service.getTuition('20230001');

    expect(result).toEqual({
      studentNo: '20230001',
      scope: 'OVERALL',
      term: null,
      currency: 'USD',
      tuitionTotal: 6800.5,
      paidAmount: 1500,
      balance: 5300.5,
      terms: [
        { term: '2026-SUMMER', tuitionTotal: 800.5, paidAmount: 0, balance: 800.5 },
        { term: '2026-FALL', tuitionTotal: 3000, paidAmount: 1500, balance: 1500 },
        { term: '2027-SPRING', tuitionTotal: 3000, paidAmount: 0, balance: 3000 },
      ],
    });
  });

  it('returns scope TERM and filters by term', async () => {
    prisma.tuition.findMany.mockResolvedValue([{ term: '2026-FALL', amount: D('3000'), payments: [] }]);

    const result = await service.getTuition('20230001', '2026-FALL');

    expect(prisma.tuition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studentId: 's1', term: '2026-FALL' } }),
    );
    expect(result).toMatchObject({ scope: 'TERM', term: '2026-FALL', balance: 3000 });
    expect(result.terms).toHaveLength(1);
  });

  it('returns zeros and no terms for a student without tuition records', async () => {
    prisma.tuition.findMany.mockResolvedValue([]);

    expect(await service.getTuition('20230001')).toMatchObject({
      scope: 'OVERALL',
      tuitionTotal: 0,
      paidAmount: 0,
      balance: 0,
      terms: [],
    });
  });

  it('throws STUDENT_NOT_FOUND for an unknown student', async () => {
    prisma.student.findUnique.mockResolvedValue(null);

    await expect(service.getTuition('20239999')).rejects.toMatchObject({ code: 'STUDENT_NOT_FOUND' });
  });

  it('throws TUITION_NOT_FOUND when a term is given but has no record', async () => {
    prisma.tuition.findMany.mockResolvedValue([]);

    await expect(service.getTuition('20230001', '2030-FALL')).rejects.toMatchObject({
      code: 'TUITION_NOT_FOUND',
    });
  });
});
