import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { BankingModule } from './banking/banking.module';
import { HealthModule } from './health/health.module';
import { MobileModule } from './mobile/mobile.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    HealthModule,
    MobileModule,
    BankingModule,
    AdminModule,
  ],
})
export class AppModule {}
