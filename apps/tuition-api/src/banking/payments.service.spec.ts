import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrisma } from '../testing/mock-prisma';
import { PaymentsService } from './payments.service';

const D = (value: string) => new Prisma.Decimal(value);
const PAID_AT = new Date('2026-11-17T14:05:00.000Z');

const dto = {
  studentNo: '20230001',
  term: '2026-FALL',
  amount: 500,
  transactionId: 'tx-12345678',
};

describe('PaymentsService.pay', () => {
  const prisma = createMockPrisma();
  const service = new PaymentsService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
    prisma.payment.findUnique.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([{ id: 't1', amount: D('3000.00') }]);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: D('1500.00') } });
    prisma.payment.create.mockResolvedValue({ transactionId: dto.transactionId, amount: D('500'), paidAt: PAID_AT });
  });

  it('records the payment and returns totals computed with decimals', async () => {
    const result = await service.pay(dto, 'user-1');

    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: { transactionId: dto.transactionId, tuitionId: 't1', amount: D('500'), paidByUserId: 'user-1' },
    });
    expect(result).toEqual({
      status: 'SUCCESS',
      transactionId: dto.transactionId,
      studentNo: '20230001',
      term: '2026-FALL',
      paidAmount: 500,
      totalPaid: 2000,
      remainingBalance: 1000,
      currency: 'USD',
      paidAt: '2026-11-17T14:05:00.000Z',
    });
  });

  it('allows paying exactly the remaining balance', async () => {
    const result = await service.pay({ ...dto, amount: 1500 }, 'user-1');

    expect(result.remainingBalance).toBe(0);
  });

  it('rejects an amount above the balance with 422 and records nothing', async () => {
    const error = await service.pay({ ...dto, amount: 1500.01 }, 'user-1').catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: 'AMOUNT_EXCEEDS_BALANCE',
      message: 'Payment amount 1500.01 exceeds the remaining balance 1500.00.',
    });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('throws TUITION_NOT_FOUND when the term has no tuition row', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(service.pay(dto, 'user-1')).rejects.toMatchObject({ code: 'TUITION_NOT_FOUND' });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  describe('duplicate transactionId', () => {
    const existing = (studentNo: string) => ({
      transactionId: dto.transactionId,
      amount: D('500'),
      paidAt: PAID_AT,
      tuitionId: 't1',
      tuition: { term: '2026-FALL', amount: D('3000'), student: { studentNo } },
    });

    it('returns 409 with the original payment when it belongs to the same student', async () => {
      prisma.payment.findUnique.mockResolvedValue(existing('20230001'));

      const error = await service.pay(dto, 'user-1').catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'DUPLICATE_TRANSACTION' });
      expect((error as { extra: { payment: unknown } }).extra.payment).toMatchObject({
        status: 'SUCCESS',
        transactionId: dto.transactionId,
        totalPaid: 1500,
        remainingBalance: 1500,
      });
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('omits the payment when it belongs to another student', async () => {
      prisma.payment.findUnique.mockResolvedValue(existing('20230002'));

      const error = await service.pay(dto, 'user-1').catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'DUPLICATE_TRANSACTION', extra: {} });
    });

    it('maps a unique-constraint race on transaction_id to 409', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.payment.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['transaction_id'] },
        }),
      );
      // After the failed transaction the winner's row is visible.
      prisma.payment.findUnique.mockResolvedValue(existing('20230001'));

      await expect(service.pay(dto, 'user-1')).rejects.toMatchObject({ code: 'DUPLICATE_TRANSACTION' });
    });
  });
});
