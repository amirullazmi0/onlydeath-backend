import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { ShippingService } from '../shipping/shipping.service.js';
import { BiteshipService } from '../shipping/biteship.service.js';
import { paginate } from '../common/dto/pagination.dto.js';
import { Currency, OrderStatus, ProductAvailability, ShippingType } from '../generated/prisma/enums.js';
import { FxService } from '../fx/fx.service.js';
import { applyDiscount } from '../products/pricing.js';
import type { Prisma } from '../generated/prisma/client.js';
import { MidtransNotification, MidtransService } from './midtrans.service.js';
import { CheckoutDto, ManualShipDto, OrderQueryDto, TrackQueryDto } from './dto/order.dto.js';

type Tx = Prisma.TransactionClient;

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_PAYMENT: 'Awaiting Payment',
  PAID: 'Paid, awaiting confirmation',
  CONFIRMED: 'Confirmed, being prepared',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};

/** Formats an amount in minor units of its currency (IDR rupiah / USD cents). */
export const money = (n: number, currency: Currency) =>
  currency === Currency.USD
    ? `US$${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `IDR ${n.toLocaleString('en-US')}`;
const countryName = (code: string) =>
  new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;

/** Human label for Midtrans payment_type values. */
export const paymentLabel = (type?: string | null) =>
  type
    ? ({
        bank_transfer: 'Bank Transfer (VA)',
        echannel: 'Mandiri Bill',
        credit_card: 'Credit / Debit Card',
        qris: 'QRIS',
        gopay: 'GoPay',
        shopeepay: 'ShopeePay',
        cstore: 'Convenience Store',
        akulaku: 'Akulaku',
        kredivo: 'Kredivo',
      }[type] ?? type.replaceAll('_', ' '))
    : 'Midtrans';

const detailInclude = {
  items: true,
  payment: true,
  logs: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OrderInclude;

type OrderDetail = Prisma.OrderGetPayload<{ include: typeof detailInclude }>;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipping: ShippingService,
    private readonly biteship: BiteshipService,
    private readonly midtrans: MidtransService,
    private readonly fx: FxService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  // ---------- Buyer ----------

  async checkout(dto: CheckoutDto) {
    const lines = await this.shipping.resolveCart(dto.items);
    const isDomestic = dto.country_code === 'ID';

    // Re-quote shipping server-side so the client cannot tamper with the cost
    const rates = await this.shipping.quote(dto, lines);
    const rate = rates.find(
      (r) => r.courier_code === dto.courier_code && r.courier_service_code === dto.courier_service,
    );
    if (!rate) throw new BadRequestException('Shipping option unavailable, please reselect');

    // Indonesia pays in IDR; everyone else sees USD and is charged the IDR
    // equivalent (Midtrans settles in IDR), with the rate locked here.
    const currency = isDomestic ? Currency.IDR : Currency.USD;
    if (!isDomestic) {
      const missing = lines.find((l) => l.product.priceUsdCents <= 0);
      if (missing) {
        throw new BadRequestException(`${missing.product.name} is not available for international orders`);
      }
    }
    const fxRate = isDomestic ? 1 : await this.fx.usdToIdr();
    type Line = (typeof lines)[number];
    const originalPrice = (l: Line) => (isDomestic ? l.product.price : l.product.priceUsdCents);
    // What the buyer pays per unit after the best active discount
    const unitPrice = (l: Line) => applyDiscount(originalPrice(l), l.discountPct);
    const toIdr = (amount: number) => (isDomestic ? amount : this.fx.centsToIdr(amount, fxRate));

    const subtotal = lines.reduce((sum, l) => sum + unitPrice(l) * l.quantity, 0);
    const discountTotal = lines.reduce(
      (sum, l) => sum + (originalPrice(l) - unitPrice(l)) * l.quantity,
      0,
    );
    // Midtrans requires item_details to sum exactly to gross_amount, so the IDR
    // charge is built from per-unit converted prices rather than converting the total.
    const chargeShipping = toIdr(rate.price);
    const chargeTotal =
      lines.reduce((sum, l) => sum + toIdr(unitPrice(l)) * l.quantity, 0) + chargeShipping;
    const orderNo = this.generateOrderNo();

    const order = await this.prisma.$transaction(async (tx) => {
      for (const { product, size, quantity } of lines) {
        if (product.availability !== ProductAvailability.READY) continue;
        // Conditional decrements guard against two buyers taking the last unit
        if (size) {
          const { count } = await tx.productSize.updateMany({
            where: { id: size.id, stock: { gte: quantity } },
            data: { stock: { decrement: quantity } },
          });
          if (count === 0) throw new ConflictException(`${product.name} (${size.label}) just sold out`);
        }
        const { count } = await tx.product.updateMany({
          where: { id: product.id, stock: { gte: quantity } },
          data: { stock: { decrement: quantity } },
        });
        if (count === 0) throw new ConflictException(`${product.name} just sold out`);
      }

      return tx.order.create({
        data: {
          orderNo,
          customerName: dto.customer_name,
          customerEmail: dto.customer_email.toLowerCase(),
          customerPhone: dto.customer_phone,
          shippingType: isDomestic ? ShippingType.DOMESTIC : ShippingType.INTERNATIONAL,
          countryCode: dto.country_code,
          address: dto.address,
          city: dto.city,
          state: dto.state,
          district: dto.district,
          subDistrict: dto.sub_district,
          areaId: isDomestic ? (dto.area_id ?? null) : null,
          postalCode: dto.postal_code,
          note: dto.note,
          courierCode: rate.courier_code,
          courierService: rate.courier_service_code,
          courierName: isDomestic
            ? `${rate.courier_name} ${rate.courier_service_name}`
            : `${rate.courier_name} (${rate.duration})`,
          currency,
          subtotal,
          shippingCost: rate.price,
          total: subtotal + rate.price,
          exchangeRate: fxRate,
          discountTotal,
          chargeShipping,
          chargeTotal,
          items: {
            create: lines.map((line) => ({
              productId: line.product.id,
              sizeId: line.size?.id,
              sizeLabel: line.size?.label,
              name: line.product.name,
              imageUrl: line.product.images[0]?.url,
              price: unitPrice(line),
              originalPrice: originalPrice(line),
              discountPct: line.discountPct,
              quantity: line.quantity,
              weightGram: line.product.weightGram,
              availability: line.product.availability,
            })),
          },
          logs: { create: { status: OrderStatus.PENDING_PAYMENT, note: 'Order placed' } },
        },
        include: { items: true },
      });
    });

    try {
      const snap = await this.midtrans.createSnap({
        orderNo,
        grossAmount: order.chargeTotal,
        items: [
          ...order.items.map((i) => ({
            id: i.sizeId ?? i.productId ?? i.id,
            name: i.sizeLabel ? `${i.name} (${i.sizeLabel})` : i.name,
            price: toIdr(i.price),
            quantity: i.quantity,
          })),
          { id: 'SHIPPING', name: `Shipping ${order.courierName}`, price: order.chargeShipping, quantity: 1 },
        ],
        customer: { name: order.customerName, email: order.customerEmail, phone: order.customerPhone },
      });

      await this.prisma.payment.create({
        data: {
          orderId: order.id,
          snapToken: snap.token,
          redirectUrl: snap.redirectUrl,
          grossAmount: order.chargeTotal,
        },
      });

      return {
        order_no: orderNo,
        snap_token: snap.token,
        redirect_url: snap.redirectUrl,
        client_key: this.midtrans.clientKey,
      };
    } catch (err) {
      await this.prisma.$transaction((tx) =>
        this.closeUnpaid(tx, order.id, OrderStatus.CANCELLED, 'Payment could not be created'),
      );
      throw err;
    }
  }

  async track({ order_no, email }: TrackQueryDto) {
    const order = await this.prisma.order.findFirst({
      where: { orderNo: order_no.trim().toUpperCase(), customerEmail: email.toLowerCase() },
      include: detailInclude,
    });
    if (!order) throw new NotFoundException('Order not found, check the order number and email');

    let tracking: Awaited<ReturnType<BiteshipService['tracking']>> | null = null;
    if (order.trackingId) {
      tracking = await this.biteship.tracking(order.trackingId).catch(() => null);
    }

    return {
      order_no: order.orderNo,
      status: order.status,
      status_label: STATUS_LABEL[order.status],
      shipping_type: order.shippingType,
      customer_name: order.customerName,
      customer_email: order.customerEmail,
      customer_phone: order.customerPhone,
      paid_at: order.paidAt,
      payment_method: order.payment?.paymentType ? paymentLabel(order.payment.paymentType) : null,
      exchange_rate: order.exchangeRate.toString(),
      store: this.storeInfo(),
      address: order.address,
      city: order.city,
      state: order.state,
      district: order.district,
      sub_district: order.subDistrict,
      area_name: order.areaName,
      postal_code: order.postalCode,
      country_code: order.countryCode,
      country_name: countryName(order.countryCode),
      courier_name: order.courierName,
      waybill: order.waybill,
      tracking_url: order.trackingUrl,
      subtotal: order.subtotal,
      shipping_cost: order.shippingCost,
      total: order.total,
      currency: order.currency,
      discount_total: order.discountTotal,
      charge_total: order.chargeTotal,
      reject_reason: order.rejectReason,
      created_at: order.createdAt,
      items: order.items.map((i) => ({
        name: i.name,
        size_label: i.sizeLabel,
        image_url: i.imageUrl,
        price: i.price,
        original_price: i.originalPrice,
        discount_pct: i.discountPct,
        quantity: i.quantity,
        availability: i.availability,
      })),
      logs: order.logs.map((l) => ({ status: l.status, note: l.note, created_at: l.createdAt })),
      // Lets the buyer reopen Snap if they closed the popup before paying
      payment:
        order.status === OrderStatus.PENDING_PAYMENT && order.payment
          ? {
              snap_token: order.payment.snapToken,
              redirect_url: order.payment.redirectUrl,
              client_key: this.midtrans.clientKey,
            }
          : null,
      tracking,
    };
  }

  // ---------- Midtrans webhook ----------

  async handleMidtransNotification(n: MidtransNotification) {
    if (!this.midtrans.verifySignature(n)) throw new BadRequestException('Invalid signature');

    const order = await this.prisma.order.findUnique({
      where: { orderNo: n.order_id },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const outcome = this.midtrans.resolveOutcome(n);
    const paymentData = {
      paymentType: n.payment_type,
      transactionId: n.transaction_id,
      transactionStatus: n.transaction_status,
      rawNotification: n as unknown as Prisma.InputJsonValue,
    };

    // Midtrans retries notifications; only PENDING_PAYMENT orders can transition
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      await this.prisma.payment.update({ where: { orderId: order.id }, data: paymentData });
      return;
    }

    if (outcome === 'PAID') {
      const paidAt = new Date();
      await this.prisma.$transaction([
        this.prisma.payment.update({
          where: { orderId: order.id },
          data: { ...paymentData, paidAt },
        }),
        this.prisma.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.PAID,
            paidAt,
            logs: { create: { status: OrderStatus.PAID, note: `Paid via ${n.payment_type}` } },
          },
        }),
      ]);
      this.sendInvoice(order, n.payment_type, paidAt);
      return;
    }

    if (outcome === 'FAILED') {
      const status =
        n.transaction_status === 'expire' ? OrderStatus.EXPIRED : OrderStatus.CANCELLED;
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({ where: { orderId: order.id }, data: paymentData });
        await this.closeUnpaid(tx, order.id, status, `Payment ${n.transaction_status}`);
      });
      return;
    }

    await this.prisma.payment.update({ where: { orderId: order.id }, data: paymentData });
  }

  // ---------- Admin ----------

  async list(query: OrderQueryDto) {
    const where: Prisma.OrderWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.search && {
        OR: [
          { orderNo: { contains: query.search, mode: 'insensitive' } },
          { customerName: { contains: query.search, mode: 'insensitive' } },
          { customerEmail: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: { items: true, payment: { select: { paymentType: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    return paginate(items, total, query);
  }

  async detail(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: detailInclude });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async confirm(id: string, actor: string) {
    const order = await this.detail(id);
    this.assertStatus(order.status, [OrderStatus.PAID]);
    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        status: OrderStatus.CONFIRMED,
        confirmedAt: new Date(),
        logs: { create: { status: OrderStatus.CONFIRMED, note: 'Order confirmed', actor } },
      },
      include: detailInclude,
    });
    this.notifyStatus(updated, 'Your order has been confirmed and is being prepared.');
    return updated;
  }

  /**
   * Domestic: books a Biteship pickup (waybill + live tracking).
   * International: records the courier and tracking number entered by the admin.
   * Separate from confirm so PO orders can wait for production.
   */
  async ship(id: string, dto: ManualShipDto, actor: string) {
    const order = await this.detail(id);
    this.assertStatus(order.status, [OrderStatus.CONFIRMED]);

    let data: Prisma.OrderUpdateInput;
    if (order.shippingType === ShippingType.DOMESTIC) {
      const shipment = await this.biteship.createOrder({
        referenceId: order.orderNo,
        destination: {
          name: order.customerName,
          phone: order.customerPhone,
          email: order.customerEmail,
          address: order.address,
          areaId: order.areaId,
          postalCode: order.postalCode,
          note: order.note,
        },
        courierCode: order.courierCode,
        courierService: order.courierService,
        items: order.items.map((i) => ({
          name: i.name,
          value: i.price,
          weight: i.weightGram,
          quantity: i.quantity,
        })),
      });
      data = {
        biteshipId: shipment.biteshipId,
        waybill: shipment.waybill,
        trackingId: shipment.trackingId,
      };
    } else {
      if (!dto.courier_name || !dto.tracking_number) {
        throw new BadRequestException('Courier name and tracking number are required');
      }
      data = {
        courierName: `${dto.courier_name} (${order.courierName})`,
        waybill: dto.tracking_number,
        trackingUrl: dto.tracking_url,
      };
    }

    const waybill = data.waybill as string | null | undefined;
    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        ...data,
        status: OrderStatus.SHIPPED,
        shippedAt: new Date(),
        logs: {
          create: {
            status: OrderStatus.SHIPPED,
            note: `Handed to courier${waybill ? `, tracking no. ${waybill}` : ''}`,
            actor,
          },
        },
      },
      include: detailInclude,
    });
    this.notifyStatus(updated, 'Your order has been handed over to the courier.');
    return updated;
  }

  /** Manual completion, mainly for international shipments without webhooks. */
  async deliver(id: string, actor: string) {
    const order = await this.detail(id);
    this.assertStatus(order.status, [OrderStatus.SHIPPED]);
    return this.markDelivered(order, actor);
  }

  async reject(id: string, reason: string, actor: string) {
    const order = await this.detail(id);
    this.assertStatus(order.status, [OrderStatus.PAID, OrderStatus.CONFIRMED]);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.restoreStock(tx, id);
      return tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.REJECTED,
          rejectReason: reason,
          logs: { create: { status: OrderStatus.REJECTED, note: reason, actor } },
        },
        include: detailInclude,
      });
    });
    this.notifyStatus(
      updated,
      `Reason: ${reason}. Your payment will be refunded by our team; contact us if you need help.`,
    );
    return updated;
  }

  // ---------- Biteship webhook ----------

  async handleBiteshipWebhook(body: { order_id?: string; status?: string }) {
    if (!body.order_id || body.status !== 'delivered') return;
    const order = await this.prisma.order.findFirst({
      where: { biteshipId: body.order_id, status: OrderStatus.SHIPPED },
      include: detailInclude,
    });
    if (order) await this.markDelivered(order, 'biteship');
  }

  // ---------- helpers ----------

  private async markDelivered(order: OrderDetail, actor: string) {
    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.DELIVERED,
        deliveredAt: new Date(),
        logs: { create: { status: OrderStatus.DELIVERED, note: 'Package delivered', actor } },
      },
      include: detailInclude,
    });
    this.notifyStatus(updated, 'Your package has been delivered. Thank you for shopping with us!');
    return updated;
  }

  private async closeUnpaid(tx: Tx, orderId: string, status: OrderStatus, note: string) {
    await this.restoreStock(tx, orderId);
    await tx.order.update({
      where: { id: orderId },
      data: { status, logs: { create: { status, note } } },
    });
  }

  private async restoreStock(tx: Tx, orderId: string) {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    for (const item of items) {
      if (item.availability !== ProductAvailability.READY || !item.productId) continue;
      if (item.sizeId) {
        // The size may have been deleted since; then only the product total is restored
        await tx.productSize.updateMany({
          where: { id: item.sizeId },
          data: { stock: { increment: item.quantity } },
        });
      }
      await tx.product.update({
        where: { id: item.productId },
        data: { stock: { increment: item.quantity } },
      });
    }
  }

  private assertStatus(current: OrderStatus, allowed: OrderStatus[]) {
    if (!allowed.includes(current)) {
      throw new BadRequestException(`Action not allowed while order is ${STATUS_LABEL[current]}`);
    }
  }

  private generateOrderNo() {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `OD-${date}-${randomBytes(4).toString('hex').toUpperCase()}`;
  }

  private trackUrl(orderNo: string) {
    return `${this.config.getOrThrow('FE_URL')}/track?order_no=${orderNo}`;
  }

  /** Street, kelurahan, kecamatan, city, province, postal code, country */
  private formatAddress(o: {
    address: string;
    subDistrict: string | null;
    district: string | null;
    city: string;
    state: string | null;
    postalCode: string;
    countryCode: string;
  }) {
    return [o.address, o.subDistrict, o.district, o.city, o.state, o.postalCode, countryName(o.countryCode)]
      .filter(Boolean)
      .join(', ');
  }

  private invoiceUrl(orderNo: string, email: string) {
    const params = new URLSearchParams({ order_no: orderNo, email });
    return `${this.config.getOrThrow('FE_URL')}/invoice?${params}`;
  }

  /** Store details printed on invoices (from STORE_* env). */
  storeInfo() {
    return {
      name: this.config.get<string>('STORE_NAME') ?? 'ONLYDEATH',
      tagline: this.config.get<string>('STORE_TAGLINE') ?? '',
      address: this.config.get<string>('STORE_ADDRESS') ?? '',
      phone: this.config.get<string>('STORE_PHONE') ?? '',
      email: this.config.get<string>('STORE_EMAIL') ?? '',
      website: this.config.get<string>('STORE_WEBSITE') ?? '',
    };
  }

  private sendInvoice(
    order: Prisma.OrderGetPayload<{ include: { items: true } }>,
    paymentType: string | undefined,
    paidAt: Date,
  ) {
    const m = (n: number) => money(n, order.currency);
    // Lines are listed at the original price; the discount is shown once in the summary
    const originalSubtotal = order.subtotal + order.discountTotal;

    this.mail.sendInBackground(order.customerEmail, `Invoice ${order.orderNo}`, 'invoice', {
      store: this.storeInfo(),
      orderNo: order.orderNo,
      invoiceDate: paidAt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerEmail: order.customerEmail,
      fullAddress: this.formatAddress(order),
      courierName: order.courierName,
      paymentMethod: paymentLabel(paymentType),
      items: order.items.map((i) => ({
        name: i.name,
        details: [
          i.sizeLabel && `Size ${i.sizeLabel}`,
          i.availability === ProductAvailability.PRE_ORDER && 'Pre-order',
          i.discountPct > 0 && `${i.discountPct}% off`,
        ]
          .filter(Boolean)
          .join(' · '),
        price: m(i.originalPrice || i.price),
        quantity: i.quantity,
        lineTotal: m((i.originalPrice || i.price) * i.quantity),
      })),
      subtotal: m(originalSubtotal),
      discountTotal: order.discountTotal ? `- ${m(order.discountTotal)}` : null,
      shippingCost: m(order.shippingCost),
      total: m(order.total),
      // International buyers are charged the IDR equivalent by Midtrans
      chargedIdr: order.currency === Currency.USD ? money(order.chargeTotal, Currency.IDR) : null,
      trackUrl: this.trackUrl(order.orderNo),
      invoiceUrl: this.invoiceUrl(order.orderNo, order.customerEmail),
    });
  }

  private notifyStatus(order: OrderDetail, note: string) {
    this.mail.sendInBackground(
      order.customerEmail,
      `Order ${order.orderNo}: ${STATUS_LABEL[order.status]}`,
      'order-status',
      {
        orderNo: order.orderNo,
        customerName: order.customerName,
        statusLabel: STATUS_LABEL[order.status],
        note,
        courierName: order.courierName,
        waybill: order.waybill,
        trackingUrl: order.trackingUrl,
        trackUrl: this.trackUrl(order.orderNo),
      },
    );
  }
}
