import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, Observable } from 'rxjs';
import { RESPONSE_MESSAGE_KEY } from '../decorators/message.decorator.js';

export interface Paginated<T> {
  items: T[];
  meta: { total_data: number; total_page: number; current_page: number; limit: number };
}

const isPaginated = (value: unknown): value is Paginated<unknown> =>
  typeof value === 'object' && value !== null && 'items' in value && 'meta' in value;

/** Wraps every handler result into { success, message, data, meta? } (kratify contract). */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const message =
      this.reflector.get<string>(RESPONSE_MESSAGE_KEY, context.getHandler()) ?? 'Success';

    return next.handle().pipe(
      map((result) => {
        // Handlers that wrote the response themselves (redirects) are left untouched
        if (context.switchToHttp().getResponse().headersSent) return result;
        if (isPaginated(result)) {
          return { success: true, message, data: result.items, meta: result.meta };
        }
        return { success: true, message, data: result ?? null };
      }),
    );
  }
}
