import {
  Global,
  Injectable,
  Logger,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const CACHE_MS = 60 * 60 * 1000;

/**
 * USD -> IDR rate used to charge international orders through Midtrans (IDR only).
 * Fetched from a free, keyless API and cached for an hour; USD_IDR_FALLBACK_RATE
 * keeps checkout working if the API is unreachable.
 */
@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  private cache: { rate: number; at: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  async usdToIdr(): Promise<number> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.rate;

    try {
      const url = this.config.get<string>('FX_API_URL') ?? 'https://open.er-api.com/v6/latest/USD';
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { rates?: Record<string, number> };
      const rate = body.rates?.IDR;
      if (!res.ok || !rate || rate <= 0) throw new Error(`unexpected response ${res.status}`);
      this.cache = { rate, at: Date.now() };
      return rate;
    } catch (err) {
      this.logger.warn(`FX fetch failed: ${(err as Error).message}`);
      // A stale cached rate beats the static fallback
      if (this.cache) return this.cache.rate;
      const fallback = Number(this.config.get('USD_IDR_FALLBACK_RATE'));
      if (fallback > 0) return fallback;
      throw new ServiceUnavailableException('Currency conversion is unavailable, please try again later');
    }
  }

  /** Converts USD cents to whole rupiah. */
  centsToIdr(cents: number, rate: number) {
    return Math.round((cents / 100) * rate);
  }
}

@Global()
@Module({
  providers: [FxService],
  exports: [FxService],
})
export class FxModule {}
