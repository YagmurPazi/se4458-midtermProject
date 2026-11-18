import { ApiProperty } from '@nestjs/swagger';

/** Shared error body, documented in Swagger for every error response. */
export class ErrorResponseDto {
  @ApiProperty({ example: 422 }) statusCode: number;
  @ApiProperty({ example: 'AMOUNT_EXCEEDS_BALANCE' }) error: string;
  @ApiProperty({ example: 'Payment amount 3500.00 exceeds the remaining balance 3000.00.' }) message: string;
  @ApiProperty({ example: '/api/v1/banking/payments' }) path: string;
  @ApiProperty({ example: '2026-11-17T14:05:00.000Z' }) timestamp: string;
}
