import { Prisma, PrismaClient, Role } from '@prisma/client';
import { hashPassword } from '../auth/password';
import { DEMO_PASSWORDS, SEED_STUDENTS, SERVICE_USERS } from './seed-data';

// Loads the demo data. Safe to run more than once: every record is upserted by its
// natural key (studentNo, username, studentId + term, transactionId), so nothing is duplicated.
//   Local:     npm run prisma:seed -w apps/tuition-api   (runs this file with ts-node)
//   Container: node dist/seed/seed.js   (or automatically at start, see --on-start below)

async function seed(prisma: PrismaClient): Promise<void> {
  const serviceUserIds: Partial<Record<Role, string>> = {};
  for (const { username, role } of SERVICE_USERS) {
    const passwordHash = await hashPassword(DEMO_PASSWORDS[role]);
    const user = await prisma.user.upsert({
      where: { username },
      update: { passwordHash, role },
      create: { username, passwordHash, role },
    });
    serviceUserIds[role] = user.id;
  }

  let tuitionCount = 0;
  let paymentCount = 0;

  for (const student of SEED_STUDENTS) {
    const { id: studentId } = await prisma.student.upsert({
      where: { studentNo: student.studentNo },
      update: { fullName: student.fullName },
      create: { studentNo: student.studentNo, fullName: student.fullName },
    });

    // Each student logs in with their student number as the username.
    const passwordHash = await hashPassword(DEMO_PASSWORDS.STUDENT);
    const { id: studentUserId } = await prisma.user.upsert({
      where: { username: student.studentNo },
      update: { passwordHash, role: Role.STUDENT, studentId },
      create: { username: student.studentNo, passwordHash, role: Role.STUDENT, studentId },
    });

    for (const tuition of student.tuitions) {
      const amount = new Prisma.Decimal(tuition.amount);
      const { id: tuitionId } = await prisma.tuition.upsert({
        where: { studentId_term: { studentId, term: tuition.term } },
        update: { amount },
        create: { studentId, term: tuition.term, amount, currency: 'USD' },
      });
      tuitionCount++;

      for (const payment of tuition.payments) {
        const paidByUserId = payment.paidBy === 'BANK' ? serviceUserIds.BANK : studentUserId;
        await prisma.payment.upsert({
          where: { transactionId: payment.transactionId },
          update: {},
          create: {
            transactionId: payment.transactionId,
            tuitionId,
            amount: new Prisma.Decimal(payment.amount),
            paidByUserId,
            paidAt: new Date(payment.paidAt),
          },
        });
        paymentCount++;
      }
    }
  }

  console.log(
    `Seed complete: ${SERVICE_USERS.length} service users, ${SEED_STUDENTS.length} students, ` +
      `${tuitionCount} tuition records, ${paymentCount} payments.`,
  );
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // --on-start: used by the container start command. Seeds only when SEED_ON_START=true and the
    // database has no students yet, so restarts never overwrite data changed through the API.
    if (process.argv.includes('--on-start')) {
      if (process.env.SEED_ON_START !== 'true') {
        return;
      }
      if ((await prisma.student.count()) > 0) {
        console.log('Seed skipped: the database already contains data.');
        return;
      }
    }
    await seed(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
