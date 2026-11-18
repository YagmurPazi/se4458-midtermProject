import { Role } from '@prisma/client';

export const JWT_ISSUER = 'tuition-auth';

/** Claims stored in the access token. */
export interface JwtPayload {
  sub: string;
  role: Role;
  /** Present for STUDENT tokens only. */
  studentNo?: string;
}

/** Authenticated caller, attached to the request by JwtStrategy. */
export interface AuthUser {
  userId: string;
  role: Role;
  studentNo?: string;
}
