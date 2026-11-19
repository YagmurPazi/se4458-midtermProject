import { INestApplication, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { hashPassword } from './auth/password';
import { PrismaService } from './prisma/prisma.service';
import { createMockPrisma } from './testing/mock-prisma';

process.env.JWT_SECRET = 'http-test-secret';

const D = (value: string) => new Prisma.Decimal(value);
const PAID_AT = new Date('2026-11-17T14:05:00.000Z');
const HEADER = 'studentNo,term,amount,currency';

describe('Tuition API over HTTP (mocked database)', () => {
  const prisma = createMockPrisma();
  let app: INestApplication;
  let jwt: JwtService;

  const token = (role: Role, studentNo?: string, options: { issuer?: string; expiresIn?: number } = {}) =>
    jwt.sign(
      { role, ...(studentNo && { studentNo }) },
      { subject: `user-${role}`, issuer: options.issuer ?? 'tuition-auth', expiresIn: options.expiresIn ?? 600 },
    );
  const bearer = (role: Role, studentNo?: string) => ({ Authorization: `Bearer ${token(role, studentNo)}` });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(() => app.close());

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
  });

  describe('error format', () => {
    it('returns the shared shape with NOT_FOUND for an unknown route', async () => {
      const res = await http().get('/api/v1/nothing').expect(404);

      expect(res.body).toEqual({
        statusCode: 404,
        error: 'NOT_FOUND',
        message: expect.any(String),
        path: '/api/v1/nothing',
        timestamp: expect.any(String),
      });
    });

    it('reports an oversized JSON body as VALIDATION_ERROR, not as a file error', async () => {
      const res = await http()
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ username: 'x', password: 'a'.repeat(200 * 1024) }))
        .expect(400);

      expect(res.body).toMatchObject({ error: 'VALIDATION_ERROR', message: 'The request body is too large.' });
    });

    it('reports malformed JSON as VALIDATION_ERROR', async () => {
      const res = await http()
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"username": ')
        .expect(400);

      expect(res.body).toMatchObject({ statusCode: 400, error: 'VALIDATION_ERROR' });
    });

    it('returns INTERNAL_ERROR without leaking details for unexpected failures', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      prisma.student.findUnique.mockRejectedValue(new Error('db exploded'));

      const res = await http().get('/api/v1/mobile/tuition').set('X-Student-No', '20230001').expect(500);

      expect(res.body).toMatchObject({ statusCode: 500, error: 'INTERNAL_ERROR', message: 'Unexpected server error.' });
      expect(JSON.stringify(res.body)).not.toContain('db exploded');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('returns a token for valid credentials', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        role: 'STUDENT',
        passwordHash: await hashPassword('Student#2026'),
        student: { studentNo: '20230001' },
      });

      const res = await http().post('/api/v1/auth/login').send({ username: '20230001', password: 'Student#2026' }).expect(200);

      expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 3600, role: 'STUDENT', studentNo: '20230001' });
      expect(typeof res.body.accessToken).toBe('string');
    });

    it('returns 401 INVALID_CREDENTIALS for an unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const res = await http().post('/api/v1/auth/login').send({ username: 'ghost', password: 'whatever' }).expect(401);

      expect(res.body).toMatchObject({ statusCode: 401, error: 'INVALID_CREDENTIALS' });
    });

    it('returns 400 VALIDATION_ERROR for an empty password', async () => {
      const res = await http().post('/api/v1/auth/login').send({ username: 'x', password: '' }).expect(400);

      expect(res.body).toMatchObject({ statusCode: 400, error: 'VALIDATION_ERROR' });
    });
  });

  describe('GET /api/v1/mobile/tuition', () => {
    it('returns the tuition summary without authentication', async () => {
      prisma.student.findUnique.mockResolvedValue({ id: 's1' });
      prisma.tuition.findMany.mockResolvedValue([{ term: '2026-FALL', amount: D('3000'), payments: [{ amount: D('1500') }] }]);

      const res = await http().get('/api/v1/mobile/tuition').set('X-Student-No', '20230001').expect(200);

      expect(res.body).toMatchObject({ studentNo: '20230001', scope: 'OVERALL', term: null, balance: 1500 });
    });

    it('returns 400 MISSING_STUDENT_NO without the header', async () => {
      const res = await http().get('/api/v1/mobile/tuition').expect(400);

      expect(res.body.error).toBe('MISSING_STUDENT_NO');
    });

    it('returns 400 VALIDATION_ERROR for a malformed header or term', async () => {
      const badHeader = await http().get('/api/v1/mobile/tuition').set('X-Student-No', '123').expect(400);
      const badTerm = await http().get('/api/v1/mobile/tuition?term=2026-WINTER').set('X-Student-No', '20230001').expect(400);

      expect(badHeader.body.error).toBe('VALIDATION_ERROR');
      expect(badTerm.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 404 STUDENT_NOT_FOUND for an unknown student', async () => {
      prisma.student.findUnique.mockResolvedValue(null);

      const res = await http().get('/api/v1/mobile/tuition').set('X-Student-No', '20239999').expect(404);

      expect(res.body.error).toBe('STUDENT_NOT_FOUND');
    });
  });

  describe('GET /api/v1/banking/tuition/:studentNo', () => {
    beforeEach(() => {
      prisma.student.findUnique.mockResolvedValue({ id: 's1' });
      prisma.tuition.findMany.mockResolvedValue([{ term: '2026-FALL', amount: D('3000'), payments: [] }]);
    });

    it('lets a student read their own tuition', async () => {
      const res = await http()
        .get('/api/v1/banking/tuition/20230001?term=2026-FALL')
        .set(bearer(Role.STUDENT, '20230001'))
        .expect(200);

      expect(res.body).toMatchObject({ scope: 'TERM', term: '2026-FALL', tuitionTotal: 3000 });
    });

    it('lets the bank read any student', async () => {
      await http().get('/api/v1/banking/tuition/20230002').set(bearer(Role.BANK)).expect(200);
    });

    it('rejects a missing, malformed, wrong-issuer or expired token with 401 UNAUTHORIZED', async () => {
      const url = '/api/v1/banking/tuition/20230001';
      const responses = await Promise.all([
        http().get(url),
        http().get(url).set('Authorization', 'Bearer not-a-jwt'),
        http().get(url).set('Authorization', `Bearer ${token(Role.BANK, undefined, { issuer: 'someone-else' })}`),
        http().get(url).set('Authorization', `Bearer ${token(Role.BANK, undefined, { expiresIn: -10 })}`),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('UNAUTHORIZED');
      }
    });

    it('returns 403 FORBIDDEN_STUDENT for another student before touching the database', async () => {
      const res = await http().get('/api/v1/banking/tuition/20230002').set(bearer(Role.STUDENT, '20230001')).expect(403);

      expect(res.body.error).toBe('FORBIDDEN_STUDENT');
      expect(prisma.student.findUnique).not.toHaveBeenCalled();
    });

    it('returns 403 FORBIDDEN_ROLE for an admin token', async () => {
      const res = await http().get('/api/v1/banking/tuition/20230001').set(bearer(Role.ADMIN)).expect(403);

      expect(res.body.error).toBe('FORBIDDEN_ROLE');
    });

    it('returns 400 VALIDATION_ERROR for a malformed student number', async () => {
      const res = await http().get('/api/v1/banking/tuition/abc').set(bearer(Role.BANK)).expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/banking/payments', () => {
    const body = { studentNo: '20230001', term: '2026-FALL', amount: 500, transactionId: 'tx-12345678' };

    beforeEach(() => {
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.$queryRaw.mockResolvedValue([{ id: 't1', amount: D('3000') }]);
      prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: D('1500') } });
      prisma.payment.create.mockResolvedValue({ transactionId: body.transactionId, amount: D('500'), paidAt: PAID_AT });
    });

    it('creates a payment and returns the documented body with 201', async () => {
      const res = await http().post('/api/v1/banking/payments').set(bearer(Role.STUDENT, '20230001')).send(body).expect(201);

      expect(res.body).toEqual({
        status: 'SUCCESS',
        transactionId: 'tx-12345678',
        studentNo: '20230001',
        term: '2026-FALL',
        paidAmount: 500,
        totalPaid: 2000,
        remainingBalance: 1000,
        currency: 'USD',
        paidAt: '2026-11-17T14:05:00.000Z',
      });
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ paidByUserId: 'user-STUDENT' }),
      });
    });

    it.each([
      ['more than 2 decimals', { amount: 10.123 }],
      ['a string amount', { amount: '10.00' }],
      ['a zero amount', { amount: 0 }],
      ['a negative amount', { amount: -5 }],
      ['a bad term', { term: '2026-WINTER' }],
      ['a short transactionId', { transactionId: 'short' }],
      ['an unknown field', { extra: true }],
    ])('returns 400 VALIDATION_ERROR for %s', async (_name, override) => {
      const res = await http()
        .post('/api/v1/banking/payments')
        .set(bearer(Role.BANK))
        .send({ ...body, ...override })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('returns 403 FORBIDDEN_STUDENT when a student pays for someone else', async () => {
      const res = await http().post('/api/v1/banking/payments').set(bearer(Role.STUDENT, '20230002')).send(body).expect(403);

      expect(res.body.error).toBe('FORBIDDEN_STUDENT');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('returns 409 DUPLICATE_TRANSACTION with the original payment', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        transactionId: body.transactionId,
        amount: D('500'),
        paidAt: PAID_AT,
        tuitionId: 't1',
        tuition: { term: '2026-FALL', amount: D('3000'), student: { studentNo: '20230001' } },
      });

      const res = await http().post('/api/v1/banking/payments').set(bearer(Role.BANK)).send(body).expect(409);

      expect(res.body).toMatchObject({ statusCode: 409, error: 'DUPLICATE_TRANSACTION', path: '/api/v1/banking/payments' });
      expect(res.body.payment).toMatchObject({ status: 'SUCCESS', transactionId: body.transactionId });
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('returns 422 AMOUNT_EXCEEDS_BALANCE with the amounts in the message', async () => {
      const res = await http().post('/api/v1/banking/payments').set(bearer(Role.BANK)).send({ ...body, amount: 3500 }).expect(422);

      expect(res.body).toMatchObject({
        error: 'AMOUNT_EXCEEDS_BALANCE',
        message: 'Payment amount 3500.00 exceeds the remaining balance 1500.00.',
      });
    });

    it('returns 404 TUITION_NOT_FOUND', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await http().post('/api/v1/banking/payments').set(bearer(Role.BANK)).send(body).expect(404);

      expect(res.body.error).toBe('TUITION_NOT_FOUND');
    });
  });

  describe('POST /api/v1/admin/tuition', () => {
    const body = { studentNo: '20230001', term: '2026-FALL', amount: 3000 };

    beforeEach(() => {
      prisma.student.findUnique.mockResolvedValue({ id: 's1' });
      prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
    });

    it('returns 201 CREATED for a new record', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await http().post('/api/v1/admin/tuition').set(bearer(Role.ADMIN)).send(body).expect(201);

      expect(res.body).toEqual({
        status: 'CREATED',
        studentNo: '20230001',
        term: '2026-FALL',
        amount: 3000,
        currency: 'USD',
        paidAmount: 0,
        balance: 3000,
      });
    });

    it('returns 200 UPDATED and 200 UNCHANGED for an existing record', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 't1', amount: D('2500') }]);
      const updated = await http().post('/api/v1/admin/tuition').set(bearer(Role.ADMIN)).send(body).expect(200);

      prisma.$queryRaw.mockResolvedValue([{ id: 't1', amount: D('3000') }]);
      const unchanged = await http().post('/api/v1/admin/tuition').set(bearer(Role.ADMIN)).send({ ...body, currency: 'USD' }).expect(200);

      expect(updated.body.status).toBe('UPDATED');
      expect(unchanged.body.status).toBe('UNCHANGED');
    });

    it('returns 422 AMOUNT_BELOW_PAID', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 't1', amount: D('3000') }]);
      prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: D('2000') } });

      const res = await http().post('/api/v1/admin/tuition').set(bearer(Role.ADMIN)).send({ ...body, amount: 1500 }).expect(422);

      expect(res.body.error).toBe('AMOUNT_BELOW_PAID');
    });

    it('returns 404 STUDENT_NOT_FOUND', async () => {
      prisma.student.findUnique.mockResolvedValue(null);

      const res = await http().post('/api/v1/admin/tuition').set(bearer(Role.ADMIN)).send(body).expect(404);

      expect(res.body.error).toBe('STUDENT_NOT_FOUND');
    });

    it.each([
      ['a non-USD currency', { currency: 'EUR' }],
      ['an amount above 1,000,000', { amount: 1000000.5 }],
      ['more than 2 decimals', { amount: 100.001 }],
      ['a bad student number', { studentNo: '1234' }],
    ])('returns 400 VALIDATION_ERROR for %s', async (_name, override) => {
      const res = await http().post('/api/v1/admin/tuition').set(bearer(Role.ADMIN)).send({ ...body, ...override }).expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 403 FORBIDDEN_ROLE for student and bank tokens', async () => {
      for (const auth of [bearer(Role.STUDENT, '20230001'), bearer(Role.BANK)]) {
        const res = await http().post('/api/v1/admin/tuition').set(auth).send(body).expect(403);
        expect(res.body.error).toBe('FORBIDDEN_ROLE');
      }
    });
  });

  describe('POST /api/v1/admin/tuition/batch', () => {
    const upload = (content: string | Buffer, auth = bearer(Role.ADMIN)) =>
      http().post('/api/v1/admin/tuition/batch').set(auth).attach('file', Buffer.from(content), 'tuition.csv');

    beforeEach(() => {
      prisma.student.findUnique.mockImplementation(({ where }: { where: { studentNo: string } }) =>
        Promise.resolve(where.studentNo === '99999999' ? null : { id: 's1' }),
      );
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
    });

    it('returns per-row results for a mixed file', async () => {
      const res = await upload(
        [HEADER, '20230001,2026-FALL,3000.00,USD', '99999999,2026-FALL,100,USD', '20230001,2026-FALL,1,USD', 'bad,row'].join('\r\n'),
      ).expect(200);

      expect(res.body).toEqual({
        totalRows: 4,
        succeeded: 1,
        failed: 3,
        results: [
          { row: 2, studentNo: '20230001', term: '2026-FALL', status: 'CREATED' },
          { row: 3, studentNo: '99999999', term: '2026-FALL', status: 'FAILED', error: 'STUDENT_NOT_FOUND' },
          { row: 4, studentNo: '20230001', term: '2026-FALL', status: 'FAILED', error: 'DUPLICATE_IN_FILE' },
          { row: 5, studentNo: 'bad', term: 'row', status: 'FAILED', error: 'VALIDATION_ERROR' },
        ],
      });
    });

    it('returns 400 INVALID_CSV_HEADER for a wrong header', async () => {
      const res = await upload('id,term\n1,2').expect(400);

      expect(res.body.error).toBe('INVALID_CSV_HEADER');
    });

    it('returns 400 MISSING_FILE when no file is sent', async () => {
      const res = await http().post('/api/v1/admin/tuition/batch').set(bearer(Role.ADMIN)).expect(400);

      expect(res.body.error).toBe('MISSING_FILE');
    });

    it('returns 400 FILE_TOO_LARGE for a file above 1 MB', async () => {
      const res = await upload(Buffer.alloc(1024 * 1024 + 1, 'a')).expect(400);

      expect(res.body.error).toBe('FILE_TOO_LARGE');
    });

    it('returns 400 MISSING_FILE when the file is sent in another multipart field', async () => {
      const res = await http()
        .post('/api/v1/admin/tuition/batch')
        .set(bearer(Role.ADMIN))
        .attach('upload', Buffer.from(HEADER), 'tuition.csv')
        .expect(400);

      expect(res.body.error).toBe('MISSING_FILE');
    });

    it('returns 403 FORBIDDEN_ROLE for a non-admin token', async () => {
      const res = await upload(HEADER, bearer(Role.STUDENT, '20230001')).expect(403);

      expect(res.body.error).toBe('FORBIDDEN_ROLE');
    });
  });

  describe('GET /api/v1/admin/tuition/unpaid', () => {
    const row = {
      studentNo: '20230003',
      fullName: 'Deniz Kaya',
      term: '2026-FALL',
      tuitionTotal: D('3000'),
      paidAmount: D('0'),
      balance: D('3000'),
      currency: 'USD',
    };

    it('returns a page and forwards sort parameters to the query', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 1n }]).mockResolvedValueOnce([row]);

      const res = await http()
        .get('/api/v1/admin/tuition/unpaid?term=2026-FALL&sortBy=studentNo&sortOrder=asc&pageSize=5')
        .set(bearer(Role.ADMIN))
        .expect(200);

      expect(res.body).toMatchObject({
        term: '2026-FALL',
        page: 1,
        pageSize: 5,
        totalItems: 1,
        totalPages: 1,
        sortBy: 'studentNo',
        sortOrder: 'asc',
        items: [{ studentNo: '20230003', fullName: 'Deniz Kaya', balance: 3000, currency: 'USD' }],
      });
      expect((prisma.$queryRaw.mock.calls[1][0] as Prisma.Sql).sql).toContain('ORDER BY s.student_no ASC');
    });

    it('returns an empty first page with totalPages 0', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 0n }]);

      const res = await http().get('/api/v1/admin/tuition/unpaid?term=2030-FALL').set(bearer(Role.ADMIN)).expect(200);

      expect(res.body).toMatchObject({ items: [], totalItems: 0, totalPages: 0 });
    });

    it('returns 400 PAGE_OUT_OF_RANGE beyond the last page', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 7n }]);

      const res = await http().get('/api/v1/admin/tuition/unpaid?term=2026-FALL&page=2').set(bearer(Role.ADMIN)).expect(400);

      expect(res.body.error).toBe('PAGE_OUT_OF_RANGE');
    });

    it.each([
      ['a missing term', ''],
      ['page 0', '?term=2026-FALL&page=0'],
      ['a non-numeric page', '?term=2026-FALL&page=abc'],
      ['pageSize 101', '?term=2026-FALL&pageSize=101'],
      ['an unknown sortBy', '?term=2026-FALL&sortBy=amount'],
      ['an unknown sortOrder', '?term=2026-FALL&sortOrder=up'],
    ])('returns 400 VALIDATION_ERROR for %s', async (_name, queryString) => {
      const res = await http().get(`/api/v1/admin/tuition/unpaid${queryString}`).set(bearer(Role.ADMIN)).expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns 403 FORBIDDEN_ROLE for a student token', async () => {
      const res = await http().get('/api/v1/admin/tuition/unpaid?term=2026-FALL').set(bearer(Role.STUDENT, '20230001')).expect(403);

      expect(res.body.error).toBe('FORBIDDEN_ROLE');
    });
  });
});
