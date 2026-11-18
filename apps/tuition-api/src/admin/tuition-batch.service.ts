import { Injectable } from '@nestjs/common';
import { AppException } from '../common/app.exception';
import { BatchResponseDto, BatchRowResultDto } from './admin.dto';
import { parseTuitionCsv, validateRow } from './tuition-csv';
import { TuitionAdminService } from './tuition-admin.service';

@Injectable()
export class TuitionBatchService {
  constructor(private readonly tuitionAdmin: TuitionAdminService) {}

  /** Processes every row independently; only file-level problems throw. */
  async importCsv(content: Buffer): Promise<BatchResponseDto> {
    const rows = parseTuitionCsv(content);
    const seen = new Set<string>();
    const results: BatchRowResultDto[] = [];

    for (const { line, fields } of rows) {
      const label = { row: line, studentNo: fields[0] ?? '', term: fields[1] ?? '' };
      const valid = validateRow(fields);
      if (!valid) {
        results.push({ ...label, status: 'FAILED', error: 'VALIDATION_ERROR' });
        continue;
      }

      const key = `${valid.studentNo}|${valid.term}`;
      if (seen.has(key)) {
        results.push({ ...label, status: 'FAILED', error: 'DUPLICATE_IN_FILE' });
        continue;
      }
      seen.add(key);

      try {
        const { status } = await this.tuitionAdmin.upsert(valid);
        results.push({ ...label, status });
      } catch (error) {
        if (!(error instanceof AppException)) {
          throw error;
        }
        results.push({ ...label, status: 'FAILED', error: error.code });
      }
    }

    const failed = results.filter((r) => r.status === 'FAILED').length;
    return { totalRows: results.length, succeeded: results.length - failed, failed, results };
  }
}
