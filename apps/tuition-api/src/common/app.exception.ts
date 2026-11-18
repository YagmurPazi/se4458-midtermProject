import { HttpException } from '@nestjs/common';

/** Error with a machine-readable code, rendered by AllExceptionsFilter in the shared error shape. */
export class AppException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    /** Additional top-level fields merged into the error body (for example the original payment). */
    readonly extra: Record<string, unknown> = {},
  ) {
    super({ code, message }, status);
  }
}
