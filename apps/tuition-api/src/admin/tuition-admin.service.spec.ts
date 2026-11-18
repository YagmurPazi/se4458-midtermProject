import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrisma } from '../testing/mock-prisma';
import { TuitionAdminService } from './tuition-admin.service';

const D = (value: string) => new Prisma.Decimal(value);
const input = { studentNo: '20230001', term: '2026-FALL', amount: D('3000') };

describe('TuitionAdminService.upsert', () => {
  const prisma = createMockPrisma();
  const service = new TuitionAdminService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
    prisma.student.findUnique.mockResolvedValue({ id: 's1' });
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: D('1000') } });
  });

  it('creates a record when none exists (CREATED)', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    const result = await service.upsert(input);

    expect(prisma.tuition.create).toHaveBeenCalledWith({
      data: { studentId: 's1', term: '2026-FALL', amount: input.amount, currency: 'USD' },
    });
    expect(result).toEqual({
      status: 'CREATED',
      studentNo: '20230001',
      term: '2026-FALL',
      amount: 3000,
      currency: 'USD',
      paidAmount: 0,
      balance: 3000,
    });
  });

  it('updates the amount when it differs (UPDATED)', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 't1', amount: D('2500') }]);

    const result = await service.upsert(input);

    expect(prisma.tuition.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { amount: input.amount } });
    expect(result).toMatchObject({ status: 'UPDATED', amount: 3000, paidAmount: 1000, balance: 2000 });
  });

  it('changes nothing when the amount is the same (UNCHANGED)', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 't1', amount: D('3000.00') }]);

    const result = await service.upsert(input);

    expect(prisma.tuition.update).not.toHaveBeenCalled();
    expect(result.status).toBe('UNCHANGED');
  });

  it('rejects an amount below what was already paid (AMOUNT_BELOW_PAID)', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 't1', amount: D('3000') }]);

    await expect(service.upsert({ ...input, amount: D('999.99') })).rejects.toMatchObject({
      code: 'AMOUNT_BELOW_PAID',
    });
    expect(prisma.tuition.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown student (STUDENT_NOT_FOUND)', async () => {
    prisma.student.findUnique.mockResolvedValue(null);

    await expect(service.upsert(input)).rejects.toMatchObject({ code: 'STUDENT_NOT_FOUND' });
  });

  it('retries once when a concurrent create for the same student and term wins the race', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['student_id', 'term'] },
    });
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 't1', amount: D('3000') }]);
    prisma.tuition.create.mockRejectedValueOnce(conflict);

    const result = await service.upsert(input);

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('UNCHANGED');
  });
});
