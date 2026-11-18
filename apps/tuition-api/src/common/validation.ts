import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsPositive, Matches, Max } from 'class-validator';
import { AppException } from './app.exception';

export const TERM_PATTERN = /^[0-9]{4}-(FALL|SPRING|SUMMER)$/;
export const STUDENT_NO_PATTERN = /^[0-9]{8}$/;
export const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_AMOUNT = 1_000_000;

/** Throws 400 VALIDATION_ERROR unless the value is an 8-digit student number. */
export function assertStudentNo(value: string): string {
  if (!STUDENT_NO_PATTERN.test(value)) {
    throw new AppException(400, 'VALIDATION_ERROR', 'studentNo must be exactly 8 digits.');
  }
  return value;
}

/** Term such as 2026-FALL. */
export function IsTerm(): PropertyDecorator {
  return applyDecorators(
    ApiProperty({ example: '2026-FALL', description: 'YYYY-FALL, YYYY-SPRING or YYYY-SUMMER' }),
    Matches(TERM_PATTERN, { message: 'term must look like 2026-FALL, 2026-SPRING or 2026-SUMMER' }),
  );
}

/** 8-digit student number. */
export function IsStudentNo(): PropertyDecorator {
  return applyDecorators(
    ApiProperty({ example: '20230001', description: '8-digit student number' }),
    Matches(STUDENT_NO_PATTERN, { message: 'studentNo must be exactly 8 digits' }),
  );
}

/** Positive JSON number with at most 2 decimal places (never rounded) and an upper bound. */
export function IsMoney(example: number): PropertyDecorator {
  return applyDecorators(
    ApiProperty({ example, description: `Greater than 0, at most ${MAX_AMOUNT}, at most 2 decimal places` }),
    IsNumber(
      { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false },
      { message: '$property must be a number with at most 2 decimal places' },
    ),
    IsPositive(),
    Max(MAX_AMOUNT),
  );
}
