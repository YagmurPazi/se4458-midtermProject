import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { AppException } from './app.exception';

interface ErrorDescription {
  status: number;
  code: string;
  message: string;
  extra?: Record<string, unknown>;
}

/** Renders every error in the documented shape: { statusCode, error, message, path, timestamp }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const { status, code, message, extra } = this.describe(exception);

    http.getResponse<Response>().status(status).json({
      statusCode: status,
      error: code,
      message,
      ...extra,
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
    });
  }

  private describe(exception: unknown): ErrorDescription {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        extra: exception.extra,
      };
    }
    if (exception instanceof HttpException) {
      return this.describeFrameworkError(exception);
    }
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Unexpected server error.',
    };
  }

  /** Errors raised by Nest itself (routing, guards, multer) rather than by our own code. */
  private describeFrameworkError(exception: HttpException): ErrorDescription {
    const status = exception.getStatus();
    const message = exception.message;
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return { status, code: 'UNAUTHORIZED', message };
      case HttpStatus.NOT_FOUND:
        return { status, code: 'NOT_FOUND', message };
      case HttpStatus.PAYLOAD_TOO_LARGE:
        // Multer's LIMIT_FILE_SIZE surfaces as 413; the API contract reports it as 400.
        return { status: HttpStatus.BAD_REQUEST, code: 'FILE_TOO_LARGE', message: 'The file exceeds the 1 MB limit.' };
      case HttpStatus.BAD_REQUEST:
        return { status, code: 'VALIDATION_ERROR', message };
      default:
        return { status, code: HttpStatus[status] ?? 'ERROR', message };
    }
  }
}
