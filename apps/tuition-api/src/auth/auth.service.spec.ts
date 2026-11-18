import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AppException } from '../common/app.exception';
import { createMockPrisma } from '../testing/mock-prisma';
import { AuthService } from './auth.service';
import { hashPassword } from './password';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthService.login', () => {
  const prisma = createMockPrisma();
  const jwt = new JwtService({ secret: 'unit-secret', signOptions: { issuer: 'tuition-auth' } });
  const config = { get: (_key: string, fallback: string) => fallback } as unknown as ConfigService;
  const service = new AuthService(prisma as unknown as PrismaService, jwt, config);

  beforeEach(() => jest.resetAllMocks());

  it('returns a signed student token with studentNo, role and lifetime in seconds', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: 'STUDENT',
      passwordHash: await hashPassword('Student#2026'),
      student: { studentNo: '20230001' },
    });

    const result = await service.login({ username: '20230001', password: 'Student#2026' });

    expect(result).toMatchObject({ tokenType: 'Bearer', expiresIn: 3600, role: 'STUDENT', studentNo: '20230001' });
    expect(jwt.verify(result.accessToken, { issuer: 'tuition-auth' })).toMatchObject({
      sub: 'user-1',
      role: 'STUDENT',
      studentNo: '20230001',
    });
  });

  it('returns studentNo null and no studentNo claim for a BANK user', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'bank-1',
      role: 'BANK',
      passwordHash: await hashPassword('Bank#2026'),
      student: null,
    });

    const result = await service.login({ username: 'bank', password: 'Bank#2026' });

    expect(result.studentNo).toBeNull();
    expect(jwt.decode(result.accessToken)).not.toHaveProperty('studentNo');
  });

  it('rejects a wrong password with INVALID_CREDENTIALS', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: 'STUDENT',
      passwordHash: await hashPassword('Student#2026'),
      student: { studentNo: '20230001' },
    });

    await expect(service.login({ username: '20230001', password: 'wrong' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('rejects an unknown user with the same error', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const error = await service.login({ username: 'nobody', password: 'x' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppException);
    expect(error).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect((error as AppException).getStatus()).toBe(401);
  });
});
