import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../common/app.exception';
import { toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { UnpaidItemDto, UnpaidQueryDto, UnpaidResponseDto } from './admin.dto';

interface UnpaidRow {
  studentNo: string;
  fullName: string;
  term: string;
  tuitionTotal: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  balance: Prisma.Decimal;
  currency: string;
}

// Whitelisted fragments: user input only selects one of these, it is never interpolated.
const SORT_COLUMNS = { balance: Prisma.raw('"balance"'), studentNo: Prisma.raw('s.student_no') };
const SORT_DIRECTIONS = { asc: Prisma.raw('ASC'), desc: Prisma.raw('DESC') };

/** Tuitions of one term that still have a balance, with the payments summed per tuition. */
function unpaidTuitions(term: string): Prisma.Sql {
  return Prisma.sql`
    FROM tuitions t
    JOIN students s ON s.id = t.student_id
    LEFT JOIN payments p ON p.tuition_id = t.id
    WHERE t.term = ${term}
    GROUP BY t.id, s.id
    HAVING t.amount - COALESCE(SUM(p.amount), 0) > 0`;
}

@Injectable()
export class UnpaidTuitionService {
  constructor(private readonly prisma: PrismaService) {}

  async list({ term, page, pageSize, sortBy, sortOrder }: UnpaidQueryDto): Promise<UnpaidResponseDto> {
    const [{ count }] = await this.prisma.$queryRaw<{ count: bigint }[]>(
      Prisma.sql`SELECT COUNT(*) AS count FROM (SELECT t.id ${unpaidTuitions(term)}) AS unpaid`,
    );
    const totalItems = Number(count);
    const totalPages = Math.ceil(totalItems / pageSize);
    if (page > Math.max(totalPages, 1)) {
      throw new AppException(400, 'PAGE_OUT_OF_RANGE', `Page ${page} is out of range; there are ${totalPages} page(s).`);
    }

    const rows =
      totalItems === 0
        ? []
        : await this.prisma.$queryRaw<UnpaidRow[]>(Prisma.sql`
            SELECT s.student_no AS "studentNo", s.full_name AS "fullName", t.term,
                   t.amount AS "tuitionTotal",
                   COALESCE(SUM(p.amount), 0) AS "paidAmount",
                   t.amount - COALESCE(SUM(p.amount), 0) AS "balance",
                   t.currency
            ${unpaidTuitions(term)}
            ORDER BY ${SORT_COLUMNS[sortBy]} ${SORT_DIRECTIONS[sortOrder]}, s.student_no ASC
            LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);

    return { term, page, pageSize, totalItems, totalPages, sortBy, sortOrder, items: rows.map(toItem) };
  }
}

function toItem(row: UnpaidRow): UnpaidItemDto {
  return {
    studentNo: row.studentNo,
    fullName: row.fullName,
    term: row.term,
    tuitionTotal: toMoney(row.tuitionTotal),
    paidAmount: toMoney(row.paidAmount),
    balance: toMoney(row.balance),
    currency: row.currency,
  };
}
