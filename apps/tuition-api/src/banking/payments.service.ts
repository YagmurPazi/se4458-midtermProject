import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../common/app.exception';
import { CURRENCY, orZero, toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { lockTuition } from '../tuition/tuition-lock';
import { CreatePaymentDto, PaymentResponseDto } from './payment.dto';

type PaymentWithOwner = Prisma.PaymentGetPayload<{
  include: { tuition: { include: { student: { select: { studentNo: true } } } } };
}>;

function isTransactionIdConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    String(error.meta?.target).includes('transaction_id')
  );
}

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  async pay(dto: CreatePaymentDto, paidByUserId: string): Promise<PaymentResponseDto> {
    try {
      return await this.prisma.$transaction((tx) => this.recordPayment(tx, dto, paidByUserId));
    } catch (error) {
      // Two concurrent requests with the same transactionId: the unique constraint stopped the second.
      if (isTransactionIdConflict(error)) {
        const duplicate = await this.duplicateException(this.prisma, dto);
        if (duplicate) {
          throw duplicate;
        }
      }
      throw error;
    }
  }

  private async recordPayment(
    tx: Prisma.TransactionClient,
    dto: CreatePaymentDto,
    paidByUserId: string,
  ): Promise<PaymentResponseDto> {
    await this.rejectDuplicate(tx, dto);

    const tuition = await lockTuition(tx, dto.studentNo, dto.term);
    if (!tuition) {
      throw new AppException(404, 'TUITION_NOT_FOUND', `Student ${dto.studentNo} has no tuition for ${dto.term}.`);
    }
    // A request with the same transactionId may have committed while this one waited for the lock.
    await this.rejectDuplicate(tx, dto);

    const amount = new Prisma.Decimal(dto.amount);
    const alreadyPaid = await this.sumPayments(tx, tuition.id);
    const balance = tuition.amount.minus(alreadyPaid);
    if (amount.gt(balance)) {
      throw new AppException(
        422,
        'AMOUNT_EXCEEDS_BALANCE',
        `Payment amount ${amount.toFixed(2)} exceeds the remaining balance ${balance.toFixed(2)}.`,
      );
    }

    const payment = await tx.payment.create({
      data: { transactionId: dto.transactionId, tuitionId: tuition.id, amount, paidByUserId },
    });
    return this.toResponse(payment, dto, alreadyPaid.plus(amount), tuition.amount);
  }

  private async rejectDuplicate(db: Prisma.TransactionClient, dto: CreatePaymentDto): Promise<void> {
    const duplicate = await this.duplicateException(db, dto);
    if (duplicate) {
      throw duplicate;
    }
  }

  /** 409 for an already used transactionId. The original payment is echoed only to the student it belongs to. */
  private async duplicateException(
    db: Prisma.TransactionClient,
    dto: CreatePaymentDto,
  ): Promise<AppException | null> {
    const existing: PaymentWithOwner | null = await db.payment.findUnique({
      where: { transactionId: dto.transactionId },
      include: { tuition: { include: { student: { select: { studentNo: true } } } } },
    });
    if (!existing) {
      return null;
    }

    const { studentNo } = existing.tuition.student;
    const extra: Record<string, unknown> = {};
    if (studentNo === dto.studentNo) {
      const totalPaid = await this.sumPayments(db, existing.tuitionId);
      extra.payment = this.toResponse(
        existing,
        { studentNo, term: existing.tuition.term },
        totalPaid,
        existing.tuition.amount,
      );
    }
    return new AppException(
      409,
      'DUPLICATE_TRANSACTION',
      `Transaction ${dto.transactionId} was already used; no new payment was recorded.`,
      extra,
    );
  }

  private async sumPayments(db: Prisma.TransactionClient, tuitionId: string): Promise<Prisma.Decimal> {
    const { _sum } = await db.payment.aggregate({ where: { tuitionId }, _sum: { amount: true } });
    return orZero(_sum.amount);
  }

  private toResponse(
    payment: { transactionId: string; amount: Prisma.Decimal; paidAt: Date },
    target: { studentNo: string; term: string },
    totalPaid: Prisma.Decimal,
    tuitionAmount: Prisma.Decimal,
  ): PaymentResponseDto {
    return {
      status: 'SUCCESS',
      transactionId: payment.transactionId,
      studentNo: target.studentNo,
      term: target.term,
      paidAmount: toMoney(payment.amount),
      totalPaid: toMoney(totalPaid),
      remainingBalance: toMoney(tuitionAmount.minus(totalPaid)),
      currency: CURRENCY,
      paidAt: payment.paidAt.toISOString(),
    };
  }
}
