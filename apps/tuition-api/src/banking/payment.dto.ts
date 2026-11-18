import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { IsMoney, IsStudentNo, IsTerm, TRANSACTION_ID_PATTERN } from '../common/validation';

export class CreatePaymentDto {
  @IsStudentNo()
  studentNo: string;

  @IsTerm()
  term: string;

  @IsMoney(500)
  amount: number;

  @ApiProperty({
    example: '9f1c2e4a-7b9d-4c1e-8a7f-1d2c3b4a5e6f',
    description: 'Idempotency key: 8-64 characters of A-Z, a-z, 0-9, _ or -',
  })
  @Matches(TRANSACTION_ID_PATTERN, { message: 'transactionId must be 8-64 characters of A-Z, a-z, 0-9, _ or -' })
  transactionId: string;
}

export class PaymentResponseDto {
  @ApiProperty({ example: 'SUCCESS' }) status: 'SUCCESS';
  @ApiProperty({ example: '9f1c2e4a-7b9d-4c1e-8a7f-1d2c3b4a5e6f' }) transactionId: string;
  @ApiProperty({ example: '20230001' }) studentNo: string;
  @ApiProperty({ example: '2026-FALL' }) term: string;
  @ApiProperty({ example: 500 }) paidAmount: number;
  @ApiProperty({ example: 2000 }) totalPaid: number;
  @ApiProperty({ example: 1000 }) remainingBalance: number;
  @ApiProperty({ example: 'USD' }) currency: string;
  @ApiProperty({ example: '2026-11-17T14:05:00.000Z' }) paidAt: string;
}
