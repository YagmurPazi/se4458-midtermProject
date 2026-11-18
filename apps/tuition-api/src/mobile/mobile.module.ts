import { Module } from '@nestjs/common';
import { TuitionModule } from '../tuition/tuition.module';
import { MobileController } from './mobile.controller';

@Module({ imports: [TuitionModule], controllers: [MobileController] })
export class MobileModule {}
