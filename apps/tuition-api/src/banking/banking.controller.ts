import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { assertCanAccessStudent } from '../auth/ownership';
import { Roles } from '../auth/roles.decorator';
import { ErrorResponseDto } from '../common/error-response.dto';
import { assertStudentNo } from '../common/validation';
import { TuitionQueryService } from '../tuition/tuition-query.service';
import { TuitionQueryDto, TuitionSummaryDto } from '../tuition/tuition-summary.dto';
import { CreatePaymentDto, PaymentResponseDto } from './payment.dto';
import { PaymentsService } from './payments.service';

@ApiTags('banking')
@Roles(Role.STUDENT, Role.BANK)
@Controller('banking')
export class BankingController {
  constructor(
    private readonly tuition: TuitionQueryService,
    private readonly payments: PaymentsService,
  ) {}

  @Get('tuition/:studentNo')
  @ApiOperation({ summary: 'Query tuition (STUDENT: own number only, BANK: any student)' })
  @ApiParam({ name: 'studentNo', example: '20230001' })
  @ApiResponse({ status: 200, type: TuitionSummaryDto })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR', type: ErrorResponseDto })
  @ApiResponse({ status: 403, description: 'FORBIDDEN_STUDENT', type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: 'STUDENT_NOT_FOUND or TUITION_NOT_FOUND', type: ErrorResponseDto })
  queryTuition(
    @CurrentUser() user: AuthUser,
    @Param('studentNo') studentNo: string,
    @Query() { term }: TuitionQueryDto,
  ) {
    assertStudentNo(studentNo);
    assertCanAccessStudent(user, studentNo);
    return this.tuition.getTuition(studentNo, term);
  }

  @Post('payments')
  @ApiOperation({ summary: 'Pay tuition (simulated); transactionId is the idempotency key' })
  @ApiResponse({ status: 201, type: PaymentResponseDto })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR', type: ErrorResponseDto })
  @ApiResponse({ status: 403, description: 'FORBIDDEN_STUDENT', type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: 'TUITION_NOT_FOUND', type: ErrorResponseDto })
  @ApiResponse({ status: 409, description: 'DUPLICATE_TRANSACTION (body may contain the original payment)', type: ErrorResponseDto })
  @ApiResponse({ status: 422, description: 'AMOUNT_EXCEEDS_BALANCE', type: ErrorResponseDto })
  pay(@CurrentUser() user: AuthUser, @Body() dto: CreatePaymentDto): Promise<PaymentResponseDto> {
    assertCanAccessStudent(user, dto.studentNo);
    return this.payments.pay(dto, user.userId);
  }
}
