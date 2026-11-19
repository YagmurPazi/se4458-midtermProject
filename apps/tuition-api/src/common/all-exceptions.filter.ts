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
    const { status, code, message, extra } = this.describe(exception, request);

    http.getResponse<Response>().status(status).json({
      statusCode: status,
      error: code,
      message,
      ...extra,
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
    });
  }

  private describe(exception: unknown, request: Request): ErrorDescription {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        extra: exception.extra,
      };
    }
    if (exception instanceof HttpException) {
      return this.describeFrameworkError(exception, request);
    }
    const bodyError = this.describeBodyParserError(exception);
    if (bodyError) {
      return bodyError;
    }
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Unexpected server error.',
    };
  }

  /** Errors from Express's body parser (raised before Nest sees the request), e.g. malformed or oversized JSON. */
  private describeBodyParserError(exception: unknown): ErrorDescription | null {
    const error = exception as { type?: unknown; status?: unknown } | null;
    if (!error || typeof error.type !== 'string' || typeof error.status !== 'number' || error.status >= 500) {
      return null;
    }
    const message =
      error.type === 'entity.too.large'
        ? 'The request body is too large.'
        : error.type === 'entity.parse.failed'
          ? 'The request body is not valid JSON.'
          : 'The request body could not be read.';
    return { status: HttpStatus.BAD_REQUEST, code: 'VALIDATION_ERROR', message };
  }

  /** Errors raised by Nest itself (routing, guards, multer) rather than by our own code. */
  private describeFrameworkError(exception: HttpException, request: Request): ErrorDescription {
    const status = exception.getStatus();
    const message = exception.message;
    const isBatchUpload = request.path.endsWith('/admin/tuition/batch');
    // Multer rejects a file sent in another multipart field than "file" ("Unexpected file field - <name>").
    if (isBatchUpload && status === HttpStatus.BAD_REQUEST && message.startsWith('Unexpected')) {
      return { status, code: 'MISSING_FILE', message: 'A CSV file is required in the multipart field "file".' };
    }
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return { status, code: 'UNAUTHORIZED', message };
      case HttpStatus.NOT_FOUND:
        return { status, code: 'NOT_FOUND', message };
      case HttpStatus.PAYLOAD_TOO_LARGE:
        // Multer's LIMIT_FILE_SIZE surfaces as 413; the API contract reports it as 400 FILE_TOO_LARGE.
        return isBatchUpload
          ? { status: HttpStatus.BAD_REQUEST, code: 'FILE_TOO_LARGE', message: 'The file exceeds the 1 MB limit.' }
          : { status: HttpStatus.BAD_REQUEST, code: 'VALIDATION_ERROR', message: 'The request body is too large.' };
      case HttpStatus.BAD_REQUEST:
        return { status, code: 'VALIDATION_ERROR', message };
      default:
        return { status, code: HttpStatus[status] ?? 'ERROR', message };
    }
  }
}
