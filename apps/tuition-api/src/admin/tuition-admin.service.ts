import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../common/app.exception';
import { CURRENCY, orZero, toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { lockTuition } from '../tuition/tuition-lock';
import { AddTuitionResponseDto, UpsertStatus } from './admin.dto';

export interface UpsertTuitionInput {
  studentNo: string;
  term: string;
  amount: Prisma.Decimal;
}

/** Create-or-update of a tuition record; shared by Add Tuition and the batch import. */
@Injectable()
export class TuitionAdminService {
  constructor(private readonly prisma: PrismaService) {}

  /** Throws AppException STUDENT_NOT_FOUND or AMOUNT_BELOW_PAID. */
  async upsert(input: UpsertTuitionInput): Promise<AddTuitionResponseDto> {
    const run = () => this.prisma.$transaction((tx) => this.upsertInTransaction(tx, input));
    try {
      return await run();
    } catch (error) {
      // Two concurrent creates for the same student and term: the unique key stopped the second one.
      // Retry once; the record now exists, so the retry takes the update path under the row lock.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return run();
      }
      throw error;
    }
  }

  private async upsertInTransaction(
    tx: Prisma.TransactionClient,
    { studentNo, term, amount }: UpsertTuitionInput,
  ): Promise<AddTuitionResponseDto> {
    const student = await tx.student.findUnique({ where: { studentNo }, select: { id: true } });
    if (!student) {
      throw new AppException(404, 'STUDENT_NOT_FOUND', `Student ${studentNo} was not found.`);
    }

    const existing = await lockTuition(tx, studentNo, term);
    if (!existing) {
      await tx.tuition.create({ data: { studentId: student.id, term, amount, currency: CURRENCY } });
      return this.toResponse('CREATED', { studentNo, term, amount, paid: new Prisma.Decimal(0) });
    }

    const { _sum } = await tx.payment.aggregate({ where: { tuitionId: existing.id }, _sum: { amount: true } });
    const paid = orZero(_sum.amount);
    if (amount.lt(paid)) {
      throw new AppException(
        422,
        'AMOUNT_BELOW_PAID',
        `New amount ${amount.toFixed(2)} is lower than the ${paid.toFixed(2)} already paid.`,
      );
    }
    if (amount.equals(existing.amount)) {
      return this.toResponse('UNCHANGED', { studentNo, term, amount, paid });
    }

    await tx.tuition.update({ where: { id: existing.id }, data: { amount } });
    return this.toResponse('UPDATED', { studentNo, term, amount, paid });
  }

  private toResponse(
    status: UpsertStatus,
    { studentNo, term, amount, paid }: UpsertTuitionInput & { paid: Prisma.Decimal },
  ): AddTuitionResponseDto {
    return {
      status,
      studentNo,
      term,
      amount: toMoney(amount),
      currency: CURRENCY,
      paidAmount: toMoney(paid),
      balance: toMoney(amount.minus(paid)),
    };
  }
}
