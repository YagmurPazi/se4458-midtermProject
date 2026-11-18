import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AppException } from '../common/app.exception';
import { AuthUser } from './auth.types';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<T = AuthUser>(err: unknown, user: T | false): T {
    if (err || !user) {
      throw new AppException(401, 'UNAUTHORIZED', 'Missing, invalid or expired access token.');
    }
    return user;
  }
}
