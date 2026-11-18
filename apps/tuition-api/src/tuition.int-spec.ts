import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { PrismaService } from './prisma/prisma.service';

// Integration tests against a real PostgreSQL. They only touch students numbered 2099xxxx.
process.env.JWT_SECRET = 'int-test-secret';
process.env.DATABASE_URL ??= 'postgresql://tuition:tuition@localhost:5432/tuition?schema=public';

const TERM = '2099-FALL';
// Separate term so the payment tests above do not leave unpaid rows in the listing.
const UNPAID_TERM = '2099-SUMMER';
const TEST_STUDENT_PREFIX = '2099';

describe('Tuition API against PostgreSQL', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bankAuth: { Authorization: string };
  let adminAuth: { Authorization: string };

  const http = () => request(app.getHttpServer());

  async function login(username: string, password: string): Promise<{ Authorization: string }> {
    const res = await http().post('/api/v1/auth/login').send({ username, password }).expect(200);
    return { Authorization: `Bearer ${res.body.accessToken}` };
  }

  async function createTuition(studentNo: string, term: string, amount: string, paid: string[] = []) {
    const student = await prisma.student.upsert({
      where: { studentNo },
      update: {},
      create: { studentNo, fullName: `Test Student ${studentNo}` },
    });
    const tuition = await prisma.tuition.create({
      data: { studentId: student.id, term, amount: new Prisma.Decimal(amount) },
    });
    for (const [index, value] of paid.entries()) {
      await prisma.payment.create({
        data: { transactionId: `seed-${studentNo}-${term}-${index}`, tuitionId: tuition.id, amount: new Prisma.Decimal(value) },
      });
    }
  }

  const pay = (studentNo: string, amount: number, transactionId: string, term = TERM) =>
    http().post('/api/v1/banking/payments').set(bankAuth).send({ studentNo, term, amount, transactionId });

  async function totalPaid(studentNo: string, term = TERM): Promise<Prisma.Decimal> {
    const { _sum } = await prisma.payment.aggregate({
      where: { tuition: { term, student: { studentNo } } },
      _sum: { amount: true },
    });
    return _sum.amount ?? new Prisma.Decimal(0);
  }

  async function cleanUp(): Promise<void> {
    const tuition = { student: { studentNo: { startsWith: TEST_STUDENT_PREFIX } } };
    await prisma.payment.deleteMany({ where: { tuition } });
    await prisma.tuition.deleteMany({ where: tuition });
    await prisma.student.deleteMany({ where: { studentNo: { startsWith: TEST_STUDENT_PREFIX } } });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);

    await cleanUp();
    bankAuth = await login('bank', 'Bank#2026');
    adminAuth = await login('admin', 'Admin#2026');
  });

  afterAll(async () => {
    await cleanUp();
    await app.close();
  });

  describe('concurrent payments', () => {
    it('lets exactly one of two payments succeed when together they exceed the balance', async () => {
      await createTuition('20990001', TERM, '1000.00');

      const responses = await Promise.all([pay('20990001', 700, 'int-race-a-0001'), pay('20990001', 700, 'int-race-b-0001')]);

      expect(responses.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(responses.find((r) => r.status === 422)?.body.error).toBe('AMOUNT_EXCEEDS_BALANCE');
      expect((await totalPaid('20990001')).toFixed(2)).toBe('700.00');
    });

    it('never lets many parallel payments overpay', async () => {
      await createTuition('20990002', TERM, '1000.00');

      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, i) => pay('20990002', 300, `int-many-${i}-00001`)),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(3);
      expect(responses.filter((r) => r.status === 422)).toHaveLength(5);
      expect((await totalPaid('20990002')).toFixed(2)).toBe('900.00');
    });

    it('records a repeated transactionId once and answers the other request with 409', async () => {
      await createTuition('20990003', TERM, '1000.00');

      const responses = await Promise.all([pay('20990003', 100, 'int-same-tx-0001'), pay('20990003', 100, 'int-same-tx-0001')]);

      expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
      const conflict = responses.find((r) => r.status === 409)!;
      expect(conflict.body.error).toBe('DUPLICATE_TRANSACTION');
      expect(conflict.body.payment).toMatchObject({ transactionId: 'int-same-tx-0001', paidAmount: 100 });
      expect(await prisma.payment.count({ where: { transactionId: 'int-same-tx-0001' } })).toBe(1);
    });

    it('answers a repeated transactionId with 409 even when the retry would now exceed the balance', async () => {
      await createTuition('20990004', TERM, '100.00');

      const responses = await Promise.all([pay('20990004', 100, 'int-full-tx-0001'), pay('20990004', 100, 'int-full-tx-0001')]);

      expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    });
  });

  describe('unpaid tuition listing', () => {
    beforeAll(async () => {
      await createTuition('20990010', UNPAID_TERM, '500.00');
      await createTuition('20990011', UNPAID_TERM, '500.00');
      await createTuition('20990012', UNPAID_TERM, '300.00');
      await createTuition('20990013', UNPAID_TERM, '1000.00', ['100.00', '0.50']); // balance 899.50
      await createTuition('20990014', UNPAID_TERM, '400.00', ['400.00']); // fully paid: excluded
    });

    const list = (query: string) => http().get(`/api/v1/admin/tuition/unpaid?term=${UNPAID_TERM}&${query}`).set(adminAuth);
    const studentNos = (res: request.Response) => res.body.items.map((i: { studentNo: string }) => i.studentNo);

    it('sorts by balance descending by default, breaking ties by studentNo ascending', async () => {
      const res = await list('').expect(200);

      expect(studentNos(res)).toEqual(['20990013', '20990010', '20990011', '20990012']);
      expect(res.body).toMatchObject({ totalItems: 4, totalPages: 1, sortBy: 'balance', sortOrder: 'desc' });
      expect(res.body.items[0]).toMatchObject({ tuitionTotal: 1000, paidAmount: 100.5, balance: 899.5, currency: 'USD' });
    });

    it('sorts by balance ascending with the same tie-break', async () => {
      const res = await list('sortBy=balance&sortOrder=asc').expect(200);

      expect(studentNos(res)).toEqual(['20990012', '20990010', '20990011', '20990013']);
    });

    it('sorts by studentNo in both directions', async () => {
      expect(studentNos(await list('sortBy=studentNo&sortOrder=asc').expect(200))).toEqual([
        '20990010', '20990011', '20990012', '20990013',
      ]);
      expect(studentNos(await list('sortBy=studentNo&sortOrder=desc').expect(200))).toEqual([
        '20990013', '20990012', '20990011', '20990010',
      ]);
    });

    it('pages with stable boundaries', async () => {
      const first = await list('pageSize=3&page=1').expect(200);
      const second = await list('pageSize=3&page=2').expect(200);

      expect(first.body).toMatchObject({ totalItems: 4, totalPages: 2, page: 1 });
      expect([...studentNos(first), ...studentNos(second)]).toEqual(['20990013', '20990010', '20990011', '20990012']);
    });

    it('rejects a page beyond the last page', async () => {
      const res = await list('pageSize=3&page=3').expect(400);

      expect(res.body.error).toBe('PAGE_OUT_OF_RANGE');
    });

    it('returns an empty first page with totalPages 0 for a term without unpaid students', async () => {
      const res = await http().get('/api/v1/admin/tuition/unpaid?term=2099-SPRING').set(adminAuth).expect(200);
      await http().get('/api/v1/admin/tuition/unpaid?term=2099-SPRING&page=2').set(adminAuth).expect(400);

      expect(res.body).toMatchObject({ items: [], totalItems: 0, totalPages: 0, page: 1 });
    });
  });

  describe('add tuition', () => {
    const add = (amount: number) =>
      http().post('/api/v1/admin/tuition').set(adminAuth).send({ studentNo: '20990020', term: TERM, amount });

    beforeAll(async () => {
      await prisma.student.create({ data: { studentNo: '20990020', fullName: 'Test Student 20990020' } });
    });

    it('creates, leaves unchanged, updates and then rejects an amount below the paid total', async () => {
      const created = await add(2000).expect(201);
      expect(created.body).toMatchObject({ status: 'CREATED', amount: 2000, paidAmount: 0, balance: 2000 });

      expect((await add(2000).expect(200)).body.status).toBe('UNCHANGED');

      const updated = await add(2500.5).expect(200);
      expect(updated.body).toMatchObject({ status: 'UPDATED', amount: 2500.5, balance: 2500.5 });

      await pay('20990020', 1000, 'int-add-pay-0001').expect(201);
      const rejected = await add(999.99).expect(422);
      expect(rejected.body.error).toBe('AMOUNT_BELOW_PAID');
      expect((await add(1000).expect(200)).body).toMatchObject({ status: 'UPDATED', paidAmount: 1000, balance: 0 });
    });

    it('handles two concurrent creates for the same student and term without a server error', async () => {
      const send = () =>
        http().post('/api/v1/admin/tuition').set(adminAuth).send({ studentNo: '20990020', term: '2098-FALL', amount: 1500 });

      const responses = await Promise.all([send(), send()]);

      expect(responses.map((r) => r.body.status).sort()).toEqual(['CREATED', 'UNCHANGED']);
      expect(await prisma.tuition.count({ where: { term: '2098-FALL', student: { studentNo: '20990020' } } })).toBe(1);
    });

    it('rejects an unknown student', async () => {
      const res = await http().post('/api/v1/admin/tuition').set(adminAuth).send({ studentNo: '20999999', term: TERM, amount: 10 }).expect(404);

      expect(res.body.error).toBe('STUDENT_NOT_FOUND');
    });

    it('imports a CSV file row by row', async () => {
      const csv = ['studentNo,term,amount,currency', '20990020,2099-SPRING,1200.00,USD', '20999999,2099-SPRING,10,USD'].join('\n');

      const res = await http().post('/api/v1/admin/tuition/batch').set(adminAuth).attach('file', Buffer.from(csv), 'rows.csv').expect(200);

      expect(res.body).toMatchObject({ totalRows: 2, succeeded: 1, failed: 1 });
      expect(res.body.results[0].status).toBe('CREATED');
      expect(res.body.results[1]).toMatchObject({ status: 'FAILED', error: 'STUDENT_NOT_FOUND' });
    });
  });
});
