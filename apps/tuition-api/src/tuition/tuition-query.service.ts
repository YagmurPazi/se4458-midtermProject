import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../common/app.exception';
import { CURRENCY, orZero, toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { TermBalanceDto, TuitionSummaryDto } from './tuition-summary.dto';

const SEASON_ORDER: Record<string, number> = { SPRING: 0, SUMMER: 1, FALL: 2 };

/** Chronological order: by year, then SPRING < SUMMER < FALL. */
function compareTerms(a: string, b: string): number {
  const [yearA, seasonA] = a.split('-');
  const [yearB, seasonB] = b.split('-');
  return Number(yearA) - Number(yearB) || SEASON_ORDER[seasonA] - SEASON_ORDER[seasonB];
}

/** Read model shared by the mobile and banking query endpoints. */
@Injectable()
export class TuitionQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async getTuition(studentNo: string, term?: string): Promise<TuitionSummaryDto> {
    const student = await this.prisma.student.findUnique({ where: { studentNo }, select: { id: true } });
    if (!student) {
      throw new AppException(404, 'STUDENT_NOT_FOUND', `Student ${studentNo} was not found.`);
    }

    const tuitions = await this.prisma.tuition.findMany({
      where: { studentId: student.id, ...(term && { term }) },
      include: { payments: { select: { amount: true } } },
    });
    if (term && tuitions.length === 0) {
      throw new AppException(404, 'TUITION_NOT_FOUND', `Student ${studentNo} has no tuition for ${term}.`);
    }

    const terms = tuitions
      .map((tuition) => {
        const paid = tuition.payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
        return { term: tuition.term, total: tuition.amount, paid };
      })
      .sort((a, b) => compareTerms(a.term, b.term));

    const total = terms.reduce((sum, t) => sum.plus(t.total), orZero(null));
    const paid = terms.reduce((sum, t) => sum.plus(t.paid), orZero(null));

    return {
      studentNo,
      scope: term ? 'TERM' : 'OVERALL',
      term: term ?? null,
      currency: CURRENCY,
      tuitionTotal: toMoney(total),
      paidAmount: toMoney(paid),
      balance: toMoney(total.minus(paid)),
      terms: terms.map(
        (t): TermBalanceDto => ({
          term: t.term,
          tuitionTotal: toMoney(t.total),
          paidAmount: toMoney(t.paid),
          balance: toMoney(t.total.minus(t.paid)),
        }),
      ),
    };
  }
}
