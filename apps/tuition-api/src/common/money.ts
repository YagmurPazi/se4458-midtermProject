import { Prisma } from '@prisma/client';

export const CURRENCY = 'USD';

/** Converts a Decimal to a JSON number with 2 decimals. All arithmetic stays in Decimal until this point. */
export function toMoney(value: Prisma.Decimal.Value): number {
  return Number(new Prisma.Decimal(value).toFixed(2));
}

/** Sum of a nullable aggregate result. */
export function orZero(value: Prisma.Decimal | null | undefined): Prisma.Decimal {
  return value ?? new Prisma.Decimal(0);
}
