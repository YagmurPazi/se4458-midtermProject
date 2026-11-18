import { Module } from '@nestjs/common';
import { TuitionModule } from '../tuition/tuition.module';
import { BankingController } from './banking.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [TuitionModule],
  controllers: [BankingController],
  providers: [PaymentsService],
})
export class BankingModule {}
