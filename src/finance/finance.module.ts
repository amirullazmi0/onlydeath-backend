import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { IsDateString, IsOptional } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { OrderStatus } from '../generated/prisma/enums.js';
import { REVENUE_STATUSES } from '../dashboard/dashboard.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PaymentGatewaysService } from '../orders/payment-gateways.service.js';

class FinanceQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

/**
 * Withdrawals happen in the payment gateway's dashboard, so this page only
 * summarises what should be in that balance and links to the dashboard.
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateways: PaymentGatewaysService,
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
      // Rejected after payment: money sits in the gateway and must be refunded manually
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
      gateway_name: this.gateways.current.name === 'midtrans' ? 'Midtrans' : 'Mayar',
      gateway_dashboard_url: this.gateways.current.dashboardUrl,
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
  imports: [OrdersModule],
  controllers: [FinanceController],
  providers: [FinanceService],
})
export class FinanceModule {}
