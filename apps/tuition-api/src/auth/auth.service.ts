import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { AppException } from '../common/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from './auth.types';
import { LoginDto, LoginResponseDto } from './login.dto';
import { verifyPassword } from './password';

// Verified against when the username is unknown, so both failure paths cost one scrypt run.
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login({ username, password }: LoginDto): Promise<LoginResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { username },
      include: { student: { select: { studentNo: true } } },
    });

    const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !passwordMatches) {
      throw new AppException(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
    }

    const studentNo = user.student?.studentNo ?? null;
    const payload: Omit<JwtPayload, 'sub'> = { role: user.role, ...(studentNo && { studentNo }) };
    const accessToken = await this.jwt.signAsync(payload, {
      subject: user.id,
      expiresIn: this.config.get<string>('JWT_EXPIRES_IN', '1h') as JwtSignOptions['expiresIn'],
    });
    const { iat, exp } = this.jwt.decode<{ iat: number; exp: number }>(accessToken);

    return { accessToken, tokenType: 'Bearer', expiresIn: exp - iat, role: user.role, studentNo };
  }
}
