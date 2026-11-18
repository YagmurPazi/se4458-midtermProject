import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { AppException } from '../common/app.exception';
import { AuthUser } from './auth.types';
import { ROLES_KEY } from './roles.constants';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const user = context.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
    if (allowed && !allowed.includes(user.role)) {
      throw new AppException(403, 'FORBIDDEN_ROLE', 'Your role is not allowed to use this operation.');
    }
    return true;
  }
}
