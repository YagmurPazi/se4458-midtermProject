import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { Response } from 'express';
import { Roles } from '../auth/roles.decorator';
import { AppException } from '../common/app.exception';
import { ErrorResponseDto } from '../common/error-response.dto';
import {
  AddTuitionDto,
  AddTuitionResponseDto,
  BatchResponseDto,
  UnpaidQueryDto,
  UnpaidResponseDto,
} from './admin.dto';
import { TuitionAdminService } from './tuition-admin.service';
import { TuitionBatchService } from './tuition-batch.service';
import { UnpaidTuitionService } from './unpaid-tuition.service';

const MAX_FILE_BYTES = 1024 * 1024;

@ApiTags('admin')
@Roles(Role.ADMIN)
@Controller('admin/tuition')
export class AdminController {
  constructor(
    private readonly tuitionAdmin: TuitionAdminService,
    private readonly batch: TuitionBatchService,
    private readonly unpaid: UnpaidTuitionService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Add tuition (create or update by studentNo + term)' })
  @ApiResponse({ status: 201, description: 'CREATED', type: AddTuitionResponseDto })
  @ApiResponse({ status: 200, description: 'UPDATED or UNCHANGED', type: AddTuitionResponseDto })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR', type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: 'STUDENT_NOT_FOUND', type: ErrorResponseDto })
  @ApiResponse({ status: 422, description: 'AMOUNT_BELOW_PAID', type: ErrorResponseDto })
  async add(
    @Body() dto: AddTuitionDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AddTuitionResponseDto> {
    const result = await this.tuitionAdmin.upsert({
      studentNo: dto.studentNo,
      term: dto.term,
      amount: new Prisma.Decimal(dto.amount),
    });
    res.status(result.status === 'CREATED' ? 201 : 200);
    return result;
  }

  @Post('batch')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add tuition from a CSV file (rows are processed independently)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary', description: 'CSV, UTF-8, at most 1 MB and 1,000 rows' } },
    },
  })
  @ApiResponse({ status: 200, type: BatchResponseDto })
  @ApiResponse({ status: 400, description: 'MISSING_FILE, INVALID_CSV_HEADER or FILE_TOO_LARGE', type: ErrorResponseDto })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  importBatch(@UploadedFile() file: Express.Multer.File | undefined): Promise<BatchResponseDto> {
    if (!file) {
      throw new AppException(400, 'MISSING_FILE', 'A CSV file is required in the multipart field "file".');
    }
    return this.batch.importCsv(file.buffer);
  }

  @Get('unpaid')
  @ApiOperation({ summary: 'List students with an unpaid balance for a term (paged, sortable)' })
  @ApiResponse({ status: 200, type: UnpaidResponseDto })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR or PAGE_OUT_OF_RANGE', type: ErrorResponseDto })
  listUnpaid(@Query() query: UnpaidQueryDto): Promise<UnpaidResponseDto> {
    return this.unpaid.list(query);
  }
}
