import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsDateString, IsOptional } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { OrderStatus } from '../generated/prisma/enums.js';
import { REVENUE_STATUSES } from '../dashboard/dashboard.module.js';

class FinanceQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

/**
 * Midtrans has no API to withdraw the merchant balance, so this page only
 * summarises what should be in the Midtrans account and links to its dashboard.
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async summary({ from, to }: FinanceQueryDto) {
    const paidAt = {
      ...(from && { gte: new Date(from) }),
      ...(to && { lte: new Date(`${to}T23:59:59.999`) }),
    };

    const [received, refundDue, byMethod, pendingPayment] = await Promise.all([
      this.prisma.order.aggregate({
        where: { status: { in: REVENUE_STATUSES }, paidAt },
        _sum: { chargeTotal: true, chargeShipping: true },
        _count: { _all: true },
      }),
      // Rejected after payment: money sits in Midtrans and must be refunded manually
      this.prisma.order.aggregate({
        where: { status: OrderStatus.REJECTED, paidAt: { not: null, ...paidAt } },
        _sum: { chargeTotal: true },
        _count: { _all: true },
      }),
      this.prisma.payment.groupBy({
        by: ['paymentType'],
        where: { paidAt: { not: null, ...paidAt }, order: { status: { in: REVENUE_STATUSES } } },
        _sum: { grossAmount: true },
        _count: { _all: true },
      }),
      this.prisma.order.aggregate({
        where: { status: OrderStatus.PENDING_PAYMENT },
        _sum: { chargeTotal: true },
        _count: { _all: true },
      }),
    ]);

    return {
      received_total: received._sum.chargeTotal ?? 0,
      received_subtotal: (received._sum.chargeTotal ?? 0) - (received._sum.chargeShipping ?? 0),
      received_shipping: received._sum.chargeShipping ?? 0,
      received_count: received._count._all,
      refund_due_total: refundDue._sum.chargeTotal ?? 0,
      refund_due_count: refundDue._count._all,
      pending_payment_total: pendingPayment._sum.chargeTotal ?? 0,
      pending_payment_count: pendingPayment._count._all,
      by_method: byMethod.map((m) => ({
        payment_type: m.paymentType ?? 'unknown',
        total: m._sum.grossAmount ?? 0,
        count: m._count._all,
      })),
      midtrans_dashboard_url:
        this.config.get('MIDTRANS_DASHBOARD_URL') ??
        (this.config.get('MIDTRANS_IS_PRODUCTION') === 'true'
          ? 'https://dashboard.midtrans.com'
          : 'https://dashboard.sandbox.midtrans.com'),
    };
  }
}

@Controller('finance')
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get()
  summary(@Query() query: FinanceQueryDto) {
    return this.finance.summary(query);
  }
}

@Module({
  controllers: [FinanceController],
  providers: [FinanceService],
})
export class FinanceModule {}
