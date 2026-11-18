import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { IsTerm } from '../common/validation';

export class TuitionQueryDto {
  @IsOptional()
  @IsTerm()
  term?: string;
}

export class TermBalanceDto {
  @ApiProperty({ example: '2026-FALL' }) term: string;
  @ApiProperty({ example: 3000 }) tuitionTotal: number;
  @ApiProperty({ example: 1500 }) paidAmount: number;
  @ApiProperty({ example: 1500 }) balance: number;
}

export class TuitionSummaryDto {
  @ApiProperty({ example: '20230001' }) studentNo: string;
  @ApiProperty({ enum: ['OVERALL', 'TERM'] }) scope: 'OVERALL' | 'TERM';
  @ApiProperty({ example: null, nullable: true, type: String }) term: string | null;
  @ApiProperty({ example: 'USD' }) currency: string;
  @ApiProperty({ example: 6000 }) tuitionTotal: number;
  @ApiProperty({ example: 1500 }) paidAmount: number;
  @ApiProperty({ example: 4500 }) balance: number;
  @ApiProperty({ type: [TermBalanceDto] }) terms: TermBalanceDto[];
}
