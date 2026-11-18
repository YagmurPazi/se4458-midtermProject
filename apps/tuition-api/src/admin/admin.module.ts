import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { TuitionAdminService } from './tuition-admin.service';
import { TuitionBatchService } from './tuition-batch.service';
import { UnpaidTuitionService } from './unpaid-tuition.service';

@Module({
  controllers: [AdminController],
  providers: [TuitionAdminService, TuitionBatchService, UnpaidTuitionService],
})
export class AdminModule {}
