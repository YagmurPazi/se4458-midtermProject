import { Role } from '@prisma/client';
import { AppException } from '../common/app.exception';
import { AuthUser } from './auth.types';

/**
 * A STUDENT may only act on the studentNo in their own token; BANK may act on any student.
 * Call this before any database lookup so other students' numbers cannot be probed.
 */
export function assertCanAccessStudent(user: AuthUser, studentNo: string): void {
  if (user.role === Role.STUDENT && user.studentNo !== studentNo) {
    throw new AppException(403, 'FORBIDDEN_STUDENT', 'A student can only access their own tuition.');
  }
}
