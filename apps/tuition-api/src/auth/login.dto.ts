import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: '20230001' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  username: string;

  @ApiProperty({ example: 'Student#2026' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;
}

export class LoginResponseDto {
  @ApiProperty({ example: '<jwt>' }) accessToken: string;
  @ApiProperty({ example: 'Bearer' }) tokenType: 'Bearer';
  @ApiProperty({ example: 3600, description: 'Token lifetime in seconds' }) expiresIn: number;
  @ApiProperty({ enum: ['STUDENT', 'BANK', 'ADMIN'] }) role: string;
  @ApiProperty({ example: '20230001', nullable: true, type: String }) studentNo: string | null;
}
