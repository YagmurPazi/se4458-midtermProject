import { Prisma } from '@prisma/client';

export interface LockedTuition {
  id: string;
  amount: Prisma.Decimal;
}

/**
 * Locks the tuition row of a student and term (SELECT ... FOR UPDATE) until the transaction ends,
 * so payments and amount changes for the same row run one after another.
 */
export async function lockTuition(
  tx: Prisma.TransactionClient,
  studentNo: string,
  term: string,
): Promise<LockedTuition | null> {
  const rows = await tx.$queryRaw<LockedTuition[]>`
    SELECT t.id, t.amount
    FROM tuitions t
    JOIN students s ON s.id = t.student_id
    WHERE s.student_no = ${studentNo} AND t.term = ${term}
    FOR UPDATE OF t`;
  return rows[0] ?? null;
}
