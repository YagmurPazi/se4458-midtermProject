import { Module } from '@nestjs/common';
import { TuitionQueryService } from './tuition-query.service';

@Module({ providers: [TuitionQueryService], exports: [TuitionQueryService] })
export class TuitionModule {}
