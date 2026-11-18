import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ErrorResponseDto } from '../common/error-response.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ROLES_KEY } from './roles.constants';
import { RolesGuard } from './roles.guard';

/** Requires a valid JWT whose role is one of the given roles. */
export function Roles(...roles: Role[]): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(ROLES_KEY, roles),
    UseGuards(JwtAuthGuard, RolesGuard),
    ApiBearerAuth(),
    ApiResponse({ status: 401, description: 'UNAUTHORIZED: missing, invalid or expired token', type: ErrorResponseDto }),
    ApiResponse({ status: 403, description: 'FORBIDDEN_ROLE: role not allowed', type: ErrorResponseDto }),
  );
}
