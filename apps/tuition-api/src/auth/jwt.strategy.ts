import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser, JWT_ISSUER, JwtPayload } from './auth.types';

/** Verifies signature (HS256), issuer and expiry; the result becomes request.user. */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      ignoreExpiration: false,
    });
  }

  validate(payload: JwtPayload): AuthUser {
    return { userId: payload.sub, role: payload.role, studentNo: payload.studentNo };
  }
}
