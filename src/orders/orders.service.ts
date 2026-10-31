import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { ShippingService } from '../shipping/shipping.service.js';
import { BiteshipService, BiteshipWebhook } from '../shipping/biteship.service.js';
import { paginate } from '../common/dto/pagination.dto.js';
import { Currency, OrderStatus, ProductAvailability, ShippingType } from '../generated/prisma/enums.js';
import { FxService } from '../fx/fx.service.js';
import { activeDiscountPct, applyDiscount } from '../products/pricing.js';
import type { Prisma } from '../generated/prisma/client.js';
import { MidtransNotification, MidtransService, PAYMENT_WINDOW_MINUTES } from './midtrans.service.js';
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

/** Two minutes past the payment window, which leaves room for late notifications. */
const STALE_ORDER_MS = (PAYMENT_WINDOW_MINUTES + 2) * 60 * 1000;
const STALE_ORDER_BATCH = 100;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

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
    const isDomestic = dto.country_code === 'ID';
    // Indonesia pays in IDR; everyone else sees USD and is charged the IDR
    // equivalent (Midtrans settles in IDR), with the rate locked here.
    const currency = isDomestic ? Currency.IDR : Currency.USD;
    // Prices differ per currency, so a mismatch means the buyer saw the wrong total
    if (dto.currency !== currency) {
      throw new BadRequestException(
        isDomestic
          ? 'Orders shipping to Indonesia are paid in IDR'
          : 'Orders shipping outside Indonesia are paid in USD',
      );
    }
    this.assertPhone(dto.customer_phone, isDomestic);

    const lines = await this.shipping.resolveCart(dto.items);
    if (isDomestic) await this.shipping.assertDomesticAddress(dto);

    // Re-quote shipping server-side so the client cannot tamper with the cost
    const rates = await this.shipping.quote(dto, lines);
    const rate = rates.find(
      (r) => r.courier_code === dto.courier_code && r.courier_service_code === dto.courier_service,
    );
    if (!rate) throw new BadRequestException('Shipping option unavailable, please reselect');

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
        // VA, QRIS and e-wallets need an Indonesian account; cards work from anywhere
        ...(!isDomestic && { enabledPayments: ['credit_card'] }),
      });

      await this.prisma.payment.create({
        data: {
          orderId: order.id,
          snapToken: snap.token,
          redirectUrl: snap.redirectUrl,
          grossAmount: order.chargeTotal,
        },
      });
      this.sendPaymentRequest(order);

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

  private async findForBuyer({ order_no, email }: TrackQueryDto) {
    const order = await this.prisma.order.findFirst({
      where: { orderNo: order_no.trim().toUpperCase(), customerEmail: email.toLowerCase() },
      include: detailInclude,
    });
    if (!order) throw new NotFoundException('Order not found, check the order number and email');
    return order;
  }

  /**
   * Buyer cancels an unpaid order, also how they switch payment method: Snap locks
   * the method once picked and an order id cannot be reused, so they check out again.
   * Midtrans is asked first because a payment may have landed before its webhook.
   */
  async cancel(dto: TrackQueryDto) {
    const order = await this.findForBuyer(dto);
    this.assertStatus(order.status, [OrderStatus.PENDING_PAYMENT]);

    const transaction = await this.midtrans.getStatus(order.orderNo);
    if (transaction) {
      const outcome = this.midtrans.resolveOutcome(transaction);
      if (outcome === 'PAID') {
        await this.applyPaymentStatus(transaction);
        throw new ConflictException('This order has already been paid');
      }
      if (outcome === 'PENDING') await this.midtrans.cancel(order.orderNo);
    }

    await this.prisma.$transaction((tx) =>
      this.closeUnpaid(tx, order.id, OrderStatus.CANCELLED, 'Cancelled by buyer'),
    );
    this.notifyStatus(
      { ...order, status: OrderStatus.CANCELLED },
      'Your order has been cancelled and no payment was taken. You can place a new order anytime.',
    );
    return { order_no: order.orderNo, cart_items: await this.toCartItems(order) };
  }

  /** Puts a cancelled order back in the guest cart, at today's prices and stock. */
  private async toCartItems(order: OrderDetail) {
    const productIds = order.items.flatMap((i) => i.productId ?? []);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, deletedAt: null, isActive: true },
      include: { images: { orderBy: { sort: 'asc' }, take: 1 }, sizes: true, discounts: true },
    });

    return order.items.flatMap((item) => {
      const product = products.find((p) => p.id === item.productId);
      const size = product?.sizes.find((s) => s.id === item.sizeId);
      if (!product || (item.sizeId && !size)) return [];
      const ready = product.availability === ProductAvailability.READY;
      const stock = ready ? (size?.stock ?? product.stock) : undefined;
      if (stock === 0) return [];
      return [
        {
          product_id: product.id,
          size_id: size?.id,
          size_label: size?.label,
          slug: product.slug,
          name: product.name,
          image_url: product.images[0]?.url,
          price: product.price,
          price_usd_cents: product.priceUsdCents,
          discount_pct: activeDiscountPct(product.discounts),
          availability: product.availability,
          stock,
          quantity: item.quantity,
        },
      ];
    });
  }

  async track(dto: TrackQueryDto) {
    const order = await this.findForBuyer(dto);

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

  /**
   * A notification only says "look at this order". The state comes from Midtrans
   * itself over our authenticated API call, so a forged request changes nothing.
   * Unknown ids get a 2xx: the dashboard's test button sends one, and an error
   * would fail that test and make Midtrans retry an order that will never exist.
   */
  async handleMidtransNotification(n: Pick<MidtransNotification, 'order_id'>) {
    const orderNo = n?.order_id;
    const known =
      typeof orderNo === 'string' &&
      (await this.prisma.order.findUnique({ where: { orderNo }, select: { id: true } }));
    if (!known) {
      this.logger.warn(`Ignored Midtrans notification for unknown order ${String(orderNo)}`);
      return;
    }

    const status = await this.midtrans.getStatus(orderNo);
    if (status) await this.applyPaymentStatus(status);
  }

  private async applyPaymentStatus(n: MidtransNotification) {
    const order = await this.prisma.order.findUnique({
      where: { orderNo: n.order_id },
      include: { items: true, payment: true },
    });
    if (!order) return;

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
      // A Snap tab left open can still be paid after the order closed; its stock is
      // gone, so the admin has to refund it. Retried webhooks must not log this twice.
      const closed = order.status === OrderStatus.CANCELLED || order.status === OrderStatus.EXPIRED;
      if (outcome === 'PAID' && closed && order.payment?.transactionStatus !== n.transaction_status) {
        this.logger.warn(`Payment received after ${order.orderNo} closed`);
        await this.prisma.orderStatusLog.create({
          data: {
            orderId: order.id,
            status: order.status,
            // Buyers see this log on the track page
            note: 'Payment received after this order closed, a refund is required',
          },
        });
      }
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
      const closed = await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({ where: { orderId: order.id }, data: paymentData });
        return this.closeUnpaid(tx, order.id, status, `Payment ${n.transaction_status}`);
      });
      if (closed && status === OrderStatus.EXPIRED) this.notifyExpired(order);
      return;
    }

    await this.prisma.payment.update({ where: { orderId: order.id }, data: paymentData });
  }

  /**
   * Midtrans never notifies about a Snap the buyer closed before picking a
   * payment method, so those orders would hold their stock forever. Anything
   * Midtrans does know about goes through the normal notification flow.
   */
  @Cron('* * * * *')
  async expireStaleOrders() {
    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING_PAYMENT,
        createdAt: { lt: new Date(Date.now() - STALE_ORDER_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: STALE_ORDER_BATCH,
    });

    for (const order of orders) {
      try {
        const status = await this.midtrans.getStatus(order.orderNo);
        if (status) {
          await this.applyPaymentStatus(status);
        } else {
          const closed = await this.prisma.$transaction((tx) =>
            this.closeUnpaid(tx, order.id, OrderStatus.EXPIRED, 'Payment window expired'),
          );
          if (closed) this.notifyExpired(order);
        }
      } catch (err) {
        // Left pending on purpose: the next run retries it
        this.logger.warn(`Could not expire ${order.orderNo}: ${(err as Error).message}`);
      }
    }
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
   * International: never touches Biteship; records the courier, tracking number
   * and shipping document entered by the admin.
   * Separate from confirm so PO orders can wait for production.
   */
  async ship(id: string, dto: ManualShipDto, actor: string) {
    const order = await this.detail(id);
    this.assertStatus(order.status, [OrderStatus.CONFIRMED]);

    let data: Prisma.OrderUpdateInput;
    if (order.shippingType === ShippingType.DOMESTIC) {
      const shipment = await this.biteship.createOrder({
        referenceId: order.orderNo,
        origin: await this.shipping.requireOrigin(),
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
        trackingUrl: shipment.trackingUrl,
      };
    } else {
      if (!dto.courier_name || !dto.tracking_number) {
        throw new BadRequestException('Courier name and tracking number are required');
      }
      data = {
        courierName: `${dto.courier_name} (${order.courierName})`,
        waybill: dto.tracking_number,
        trackingUrl: dto.tracking_url,
        shippingDocumentUrl: dto.shipping_document_url,
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

  async handleBiteshipWebhook(body: BiteshipWebhook) {
    if (!body.order_id) return;

    // The waybill can be missing at booking and changes when the courier hands over
    const shipment = {
      ...(body.courier_waybill_id && { waybill: body.courier_waybill_id }),
      ...(body.courier_tracking_id && { trackingId: body.courier_tracking_id }),
      ...(body.courier_link && { trackingUrl: body.courier_link }),
    };
    if (Object.keys(shipment).length > 0) {
      await this.prisma.order.updateMany({ where: { biteshipId: body.order_id }, data: shipment });
    }

    if (body.status !== 'delivered') return;
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

  /** Returns false when the order was already closed by something else. */
  private async closeUnpaid(tx: Tx, orderId: string, status: OrderStatus, note: string) {
    // Conditional update so a webhook and the expiry job cannot both restore stock
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { status },
    });
    if (count === 0) return false;
    await tx.orderStatusLog.create({ data: { orderId, status, note } });
    await this.restoreStock(tx, orderId);
    return true;
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

  /** Couriers need a reachable number: Indonesian mobile, or international format abroad. */
  private assertPhone(phone: string, isDomestic: boolean) {
    const digits = phone.replace(/[\s()-]/g, '');
    if (isDomestic && !/^(\+62|62|0)8\d{7,12}$/.test(digits)) {
      throw new BadRequestException('Invalid Indonesian mobile number');
    }
    if (!isDomestic && !digits.startsWith('+')) {
      throw new BadRequestException('Phone number must include the country code, e.g. +1');
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
      logoUrl: `${this.config.getOrThrow('FE_URL')}/brand/logo-black.png`,
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
      // Keeps the column lines running down the page on short orders
      blankRows: Array.from({ length: Math.max(0, 4 - order.items.length) }),
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

  private sendPaymentRequest(order: Prisma.OrderGetPayload<{ include: { items: true } }>) {
    const m = (n: number) => money(n, order.currency);
    const params = new URLSearchParams({ order_no: order.orderNo, email: order.customerEmail });
    const url = `${this.config.getOrThrow('FE_URL')}/track?${params}`;

    this.mail.sendInBackground(
      order.customerEmail,
      `Complete your payment for ${order.orderNo}`,
      'order-placed',
      {
        orderNo: order.orderNo,
        customerName: order.customerName,
        items: order.items.map((i) => ({
          name: i.name,
          details: i.sizeLabel && `Size ${i.sizeLabel}`,
          quantity: i.quantity,
          lineTotal: m(i.price * i.quantity),
        })),
        courierName: order.courierName,
        shippingCost: m(order.shippingCost),
        total: m(order.total),
        chargedIdr: order.currency === Currency.USD ? money(order.chargeTotal, Currency.IDR) : null,
        paymentMinutes: PAYMENT_WINDOW_MINUTES,
        payUrl: url,
        // Only opens a confirmation: mail scanners follow every link they see
        cancelUrl: `${url}&action=cancel`,
      },
    );
  }

  private notifyExpired(order: Prisma.OrderGetPayload<object>) {
    this.notifyStatus(
      { ...order, status: OrderStatus.EXPIRED },
      `The ${PAYMENT_WINDOW_MINUTES}-minute payment window has ended, so this order was cancelled and no payment was taken. You can place a new order anytime.`,
    );
  }

  private notifyStatus(order: Prisma.OrderGetPayload<object>, note: string) {
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
