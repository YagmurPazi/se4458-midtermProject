import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CURRENCY } from '../common/money';
import { IsMoney, IsStudentNo, IsTerm } from '../common/validation';

export type UpsertStatus = 'CREATED' | 'UPDATED' | 'UNCHANGED';

export class AddTuitionDto {
  @IsStudentNo()
  studentNo: string;

  @IsTerm()
  term: string;

  @IsMoney(3000)
  amount: number;

  @ApiPropertyOptional({ example: CURRENCY, description: 'Only USD is supported' })
  @IsOptional()
  @IsIn([CURRENCY], { message: `currency must be ${CURRENCY}` })
  currency?: string;
}

export class AddTuitionResponseDto {
  @ApiProperty({ enum: ['CREATED', 'UPDATED', 'UNCHANGED'] }) status: UpsertStatus;
  @ApiProperty({ example: '20230001' }) studentNo: string;
  @ApiProperty({ example: '2026-FALL' }) term: string;
  @ApiProperty({ example: 3000 }) amount: number;
  @ApiProperty({ example: CURRENCY }) currency: string;
  @ApiProperty({ example: 0 }) paidAmount: number;
  @ApiProperty({ example: 3000 }) balance: number;
}

export class BatchRowResultDto {
  @ApiProperty({ example: 2, description: 'Line number in the file (header is line 1)' }) row: number;
  @ApiProperty({ example: '20230001' }) studentNo: string;
  @ApiProperty({ example: '2026-FALL' }) term: string;
  @ApiProperty({ enum: ['CREATED', 'UPDATED', 'UNCHANGED', 'FAILED'] }) status: UpsertStatus | 'FAILED';
  @ApiPropertyOptional({ example: 'STUDENT_NOT_FOUND' }) error?: string;
}

export class BatchResponseDto {
  @ApiProperty({ example: 3 }) totalRows: number;
  @ApiProperty({ example: 2 }) succeeded: number;
  @ApiProperty({ example: 1 }) failed: number;
  @ApiProperty({ type: [BatchRowResultDto] }) results: BatchRowResultDto[];
}

export class UnpaidQueryDto {
  @IsTerm()
  term: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  @ApiPropertyOptional({ enum: ['balance', 'studentNo'], default: 'balance' })
  @IsOptional()
  @IsIn(['balance', 'studentNo'])
  sortBy: 'balance' | 'studentNo' = 'balance';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'desc';
}

export class UnpaidItemDto {
  @ApiProperty({ example: '20230003' }) studentNo: string;
  @ApiProperty({ example: 'Deniz Kaya' }) fullName: string;
  @ApiProperty({ example: '2026-FALL' }) term: string;
  @ApiProperty({ example: 3000 }) tuitionTotal: number;
  @ApiProperty({ example: 0 }) paidAmount: number;
  @ApiProperty({ example: 3000 }) balance: number;
  @ApiProperty({ example: CURRENCY }) currency: string;
}

export class UnpaidResponseDto {
  @ApiProperty({ example: '2026-FALL' }) term: string;
  @ApiProperty({ example: 1 }) page: number;
  @ApiProperty({ example: 20 }) pageSize: number;
  @ApiProperty({ example: 7 }) totalItems: number;
  @ApiProperty({ example: 1 }) totalPages: number;
  @ApiProperty({ enum: ['balance', 'studentNo'] }) sortBy: string;
  @ApiProperty({ enum: ['asc', 'desc'] }) sortOrder: string;
  @ApiProperty({ type: [UnpaidItemDto] }) items: UnpaidItemDto[];
}
