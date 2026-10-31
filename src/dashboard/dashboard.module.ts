import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { OrderStatus } from '../generated/prisma/enums.js';

/** Statuses where the buyer's money has been received and kept. */
export const REVENUE_STATUSES = [
  OrderStatus.PAID,
  OrderStatus.CONFIRMED,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const since = new Date(now.getTime() - 29 * 86_400_000);
    since.setHours(0, 0, 0, 0);

    const [byStatus, revenueAll, revenueMonth, daily, topProducts, lowStock, recentOrders, productCount] =
      await Promise.all([
        this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.order.aggregate({
          where: { status: { in: REVENUE_STATUSES } },
          _sum: { chargeTotal: true },
        }),
        this.prisma.order.aggregate({
          where: { status: { in: REVENUE_STATUSES }, paidAt: { gte: monthStart } },
          _sum: { chargeTotal: true },
          _count: { _all: true },
        }),
        this.prisma.$queryRaw<{ day: Date; revenue: bigint; orders: bigint }[]>`
          SELECT date_trunc('day', paid_at) AS day, SUM(charge_total) AS revenue, COUNT(*) AS orders
          FROM orders
          WHERE paid_at >= ${since} AND status::text = ANY(${REVENUE_STATUSES})
          GROUP BY 1 ORDER BY 1`,
        this.prisma.orderItem.groupBy({
          by: ['name'],
          where: { order: { status: { in: REVENUE_STATUSES } } },
          _sum: { quantity: true },
          orderBy: { _sum: { quantity: 'desc' } },
          take: 5,
        }),
        this.prisma.product.findMany({
          where: { deletedAt: null, isActive: true, availability: 'READY', stock: { lte: 5 } },
          select: { id: true, name: true, stock: true },
          orderBy: { stock: 'asc' },
          take: 5,
        }),
        this.prisma.order.findMany({
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            orderNo: true,
            customerName: true,
            total: true,
            currency: true,
            status: true,
            createdAt: true,
          },
        }),
        this.prisma.product.count({ where: { deletedAt: null } }),
      ]);

    // Fill missing days with zero so the chart has a continuous x-axis
    const dailyMap = new Map(daily.map((d) => [d.day.toISOString().slice(0, 10), d]));
    const dailySales = Array.from({ length: 30 }, (_, i) => {
      const key = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      const row = dailyMap.get(key);
      return { date: key, revenue: Number(row?.revenue ?? 0), orders: Number(row?.orders ?? 0) };
    });

    return {
      total_revenue: revenueAll._sum.chargeTotal ?? 0,
      month_revenue: revenueMonth._sum.chargeTotal ?? 0,
      month_orders: revenueMonth._count._all,
      product_count: productCount,
      orders_by_status: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      daily_sales: dailySales,
      top_products: topProducts.map((p) => ({ name: p.name, quantity: p._sum.quantity ?? 0 })),
      low_stock: lowStock,
      recent_orders: recentOrders,
    };
  }
}

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  summary() {
    return this.dashboard.summary();
  }
}

@Module({
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
