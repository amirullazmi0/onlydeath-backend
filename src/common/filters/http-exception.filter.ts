import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/** Error envelope matching the FE ErrorResponse type: { success, message, error }. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const raw =
        typeof body === 'string' ? body : (body as { message?: string | string[] }).message;
      res.status(exception.getStatus()).json({
        success: false,
        message: Array.isArray(raw) ? 'Validation failed' : (raw ?? exception.message),
        error: Array.isArray(raw) ? raw : null,
      });
      return;
    }

    this.logger.error(exception);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: 'Internal server error',
      error: null,
    });
  }
}
