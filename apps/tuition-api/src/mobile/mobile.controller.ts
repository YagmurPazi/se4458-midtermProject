import { Controller, Get, Headers, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppException } from '../common/app.exception';
import { ErrorResponseDto } from '../common/error-response.dto';
import { assertStudentNo } from '../common/validation';
import { TuitionQueryService } from '../tuition/tuition-query.service';
import { TuitionQueryDto, TuitionSummaryDto } from '../tuition/tuition-summary.dto';

@ApiTags('mobile')
@Controller('mobile/tuition')
export class MobileController {
  constructor(private readonly tuition: TuitionQueryService) {}

  @Get()
  @ApiOperation({ summary: 'Query tuition (mobile app, no auth; limited to 3 calls per student per day by the gateway)' })
  @ApiHeader({ name: 'X-Student-No', required: true, example: '20230001' })
  @ApiResponse({ status: 200, type: TuitionSummaryDto })
  @ApiResponse({ status: 400, description: 'MISSING_STUDENT_NO or VALIDATION_ERROR', type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: 'STUDENT_NOT_FOUND or TUITION_NOT_FOUND', type: ErrorResponseDto })
  query(@Headers('x-student-no') studentNo: string | undefined, @Query() { term }: TuitionQueryDto) {
    if (!studentNo) {
      throw new AppException(400, 'MISSING_STUDENT_NO', 'The X-Student-No header is required.');
    }
    return this.tuition.getTuition(assertStudentNo(studentNo), term);
  }
}
