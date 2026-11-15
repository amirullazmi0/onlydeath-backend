import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { OrderStatus, ProductAvailability } from '../generated/prisma/enums.js';
import { ShippingService } from '../shipping/shipping.service.js';
import { MayarService } from './mayar.service.js';
import { MidtransService } from './midtrans.service.js';
import { PaymentGatewaysService } from './payment-gateways.service.js';
import { OrdersService } from './orders.service.js';

const OLD = new Date(Date.now() - 26 * 60 * 60 * 1000);

/** Just enough Prisma for the expiry and webhook flows, backed by one order. */
const setup = () => {
  const order = {
    id: 'order-1',
    orderNo: 'OD-1',
    status: OrderStatus.PENDING_PAYMENT as OrderStatus,
    createdAt: OLD,
    biteshipId: 'bs-1',
    waybill: null as string | null,
    trackingId: null as string | null,
    trackingUrl: null as string | null,
    countryCode: 'ID',
    currency: 'IDR',
    subtotal: 100,
    discountTotal: 0,
    shippingCost: 10,
    total: 110,
    chargeTotal: 110,
  };
  const logs: { status: OrderStatus; note: string }[] = [];
  let stock = 5;

  const client = {
    order: {
      findMany: vi.fn(async () =>
        order.status === OrderStatus.PENDING_PAYMENT ? [{ ...order, payment: { gateway: 'mayar', gatewayRef: 'pay-1' } }] : [],
      ),
      findUnique: vi.fn(async (): Promise<unknown> => ({ ...order, items: [] })),
      findFirst: vi.fn(async (): Promise<unknown> => null),
      updateMany: vi.fn(async ({ where, data }: { where: { status?: OrderStatus }; data: object }) => {
        if (where.status && where.status !== order.status) return { count: 0 };
        Object.assign(order, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: { status: OrderStatus } }) => {
        order.status = data.status;
        return order;
      }),
    },
    orderItem: {
      findMany: vi.fn(async () => [
        { availability: ProductAvailability.READY, productId: 'p-1', sizeId: null, quantity: 2 },
      ]),
    },
    product: {
      update: vi.fn(async ({ data }: { data: { stock: { increment: number } } }) => {
        stock += data.stock.increment;
      }),
      findMany: vi.fn(async () => []),
    },
    productSize: { updateMany: vi.fn() },
    orderStatusLog: {
      create: vi.fn(async ({ data }: { data: { status: OrderStatus; note: string } }) => {
        logs.push(data);
      }),
    },
    payment: {
      update: vi.fn(async () => undefined),
      findFirst: vi.fn(
        async ({ where }: { where: { gatewayRef: { in: string[] } } }): Promise<unknown> =>
          where.gatewayRef.in.includes('pay-1') ? { orderId: order.id, gatewayRef: 'pay-1' } : null,
      ),
    },
  };
  const prisma = {
    ...client,
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function' ? arg(client) : Promise.all(arg as unknown[]),
    ),
  };
  const mayar = {
    name: 'mayar',
    getStatus: vi.fn(),
    close: vi.fn(async (_ref: string) => undefined),
  };
  const mail = { sendInBackground: vi.fn() };
  const service = new OrdersService(
    prisma as never,
    {} as never,
    {} as never,
    { current: mayar, get: () => mayar } as never,
    {} as never,
    mail as never,
    { get: vi.fn(), getOrThrow: vi.fn(() => 'http://fe') } as never,
  );
  return { service, mayar, mail, prisma, order, logs, stock: () => stock };
};

const paid = { outcome: 'PAID', status: 'paid', expired: false, paymentType: 'qris', raw: {} };
const unpaid = { outcome: 'PENDING', status: 'unpaid', expired: false, raw: {} };

describe('OrdersService.checkout destination rules', () => {
  const domestic = { country_code: 'ID', currency: 'IDR', customer_phone: '0812 3456 7890' };
  const abroad = { country_code: 'SG', currency: 'USD', customer_phone: '+65 8123 4567' };
  const checkout = (dto: object) => setup().service.checkout(dto as never);
  // Passing the rules means reaching the next step, which the setup leaves unwired
  const passes = async (dto: object) =>
    expect(checkout(dto)).rejects.toThrow(/resolveCart/);

  it('refuses IDR for a destination outside Indonesia', async () => {
    await expect(checkout({ ...abroad, currency: 'IDR' })).rejects.toThrow('paid in USD');
  });

  it('refuses USD for a destination in Indonesia', async () => {
    await expect(checkout({ ...domestic, currency: 'USD' })).rejects.toThrow('paid in IDR');
  });

  it('accepts the matching currency for each destination', async () => {
    await passes(domestic);
    await passes(abroad);
  });

  it.each(['+62 812 3456 7890', '6281234567890', '0812-3456-7890'])('accepts ID phone %s', async (phone) => {
    await passes({ ...domestic, customer_phone: phone });
  });

  it('rejects a non-mobile Indonesian number', async () => {
    await expect(checkout({ ...domestic, customer_phone: '022 1234567' })).rejects.toThrow(
      'Invalid Indonesian mobile number',
    );
  });

  it('requires a country code abroad', async () => {
    await expect(checkout({ ...abroad, customer_phone: '8123 4567' })).rejects.toThrow('country code');
  });
});

describe('OrdersService.handleMayarWebhook', () => {
  it('ignores unknown payments without asking Mayar, like the dashboard test', async () => {
    const { service, mayar, prisma } = setup();

    await expect(
      service.handleMayarWebhook({ event: 'payment.received', data: { id: 'test-id' } }),
    ).resolves.toBeUndefined();

    expect(mayar.getStatus).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('ignores a malformed body', async () => {
    const { service, prisma } = setup();
    await expect(service.handleMayarWebhook({} as never)).resolves.toBeUndefined();
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
  });

  it('matches the payment by productId as well as id', async () => {
    const { service, mayar, order } = setup();
    mayar.getStatus.mockResolvedValue(paid);

    await service.handleMayarWebhook({ data: { id: 'tx-9', productId: 'pay-1' } });

    expect(mayar.getStatus).toHaveBeenCalledWith('pay-1');
    expect(order.status).toBe(OrderStatus.PAID);
  });

  it('marks an order paid only when Mayar itself says so', async () => {
    const { service, mayar, order } = setup();
    mayar.getStatus.mockResolvedValue(paid);

    await service.handleMayarWebhook({ data: { id: 'pay-1' } });

    expect(order.status).toBe(OrderStatus.PAID);
  });

  it('cannot be fooled by a forged payment', async () => {
    const { service, mayar, order } = setup();
    mayar.getStatus.mockResolvedValue(unpaid);

    await service.handleMayarWebhook({ data: { id: 'pay-1', status: 'paid' } });

    expect(mayar.getStatus).toHaveBeenCalledWith('pay-1');
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it('lets Mayar retry when its status cannot be read', async () => {
    const { service, mayar } = setup();
    mayar.getStatus.mockRejectedValue(new Error('Mayar status failed'));

    await expect(service.handleMayarWebhook({ data: { id: 'pay-1' } })).rejects.toThrow(
      'Mayar status failed',
    );
  });
});

describe('OrdersService.cancel', () => {
  const dto = { order_no: 'od-1', email: 'Buyer@Example.com' };
  const cancelSetup = () => {
    const ctx = setup();
    ctx.prisma.order.findFirst.mockImplementation(
      async () =>
        ({
          ...ctx.order,
          customerEmail: 'buyer@example.com',
          items: [],
          logs: [],
          payment: { gateway: 'mayar', gatewayRef: 'pay-1' },
        }) as never,
    );
    return ctx;
  };

  it('cancels an order Mayar does not know and restores stock', async () => {
    const { service, mayar, order, stock, logs } = cancelSetup();
    mayar.getStatus.mockResolvedValue(null);

    await service.cancel(dto);

    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(stock()).toBe(7);
    expect(logs[0].note).toBe('Cancelled by buyer');
    expect(mayar.close).not.toHaveBeenCalled();
  });

  it('closes the unpaid payment page before closing the order', async () => {
    const { service, mayar, order } = cancelSetup();
    mayar.getStatus.mockResolvedValue(unpaid);

    await service.cancel(dto);

    expect(mayar.close).toHaveBeenCalledWith('pay-1');
    expect(order.status).toBe(OrderStatus.CANCELLED);
  });

  it('keeps the order open when Mayar refuses to close the page', async () => {
    const { service, mayar, order, stock } = cancelSetup();
    mayar.getStatus.mockResolvedValue(unpaid);
    mayar.close.mockRejectedValue(new Error('nope'));

    await expect(service.cancel(dto)).rejects.toThrow('nope');

    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(stock()).toBe(5);
  });

  it('refuses when the payment already landed and records it', async () => {
    const { service, mayar, order, stock } = cancelSetup();
    mayar.getStatus.mockResolvedValue(paid);

    await expect(service.cancel(dto)).rejects.toThrow('already been paid');

    expect(order.status).toBe(OrderStatus.PAID);
    expect(stock()).toBe(5);
  });

  it('refuses orders past payment', async () => {
    const { service, order } = cancelSetup();
    order.status = OrderStatus.SHIPPED;
    await expect(service.cancel(dto)).rejects.toThrow('Action not allowed');
  });

  it('asks the admin to refund a payment that arrives after closing, once', async () => {
    const { service, mayar, order, logs, prisma } = setup();
    order.status = OrderStatus.CANCELLED;
    mayar.getStatus.mockResolvedValue(paid);
    const webhook = { data: { id: 'pay-1' } };

    await service.handleMayarWebhook(webhook);
    expect(logs[0].note).toContain('refund');

    prisma.order.findUnique.mockImplementation(
      async () => ({ ...order, items: [], payment: { transactionStatus: 'paid' } }) as never,
    );
    await service.handleMayarWebhook(webhook);
    expect(logs).toHaveLength(1);
  });
});

describe('OrdersService.checkout payment', () => {
  const FX_RATE = 16123.45;
  const fx = {
    usdToIdr: vi.fn(async () => FX_RATE),
    centsToIdr: (cents: number, rate: number) => Math.round((cents / 100) * rate),
  };
  const lines = [
    {
      product: {
        id: 'p-1',
        name: 'Tee',
        price: 230000,
        priceUsdCents: 7999,
        weightGram: 300,
        availability: ProductAvailability.PRE_ORDER,
        images: [],
      },
      size: null,
      quantity: 3,
      discountPct: 15,
    },
  ];

  const paySetup = (price: number) => {
    const shipping = new ShippingService({} as never, {} as never, fx as never);
    vi.spyOn(shipping, 'resolveCart').mockResolvedValue(lines as never);
    vi.spyOn(shipping, 'assertDomesticAddress').mockResolvedValue();
    vi.spyOn(shipping, 'quote').mockResolvedValue([
      { courier_code: 'C', courier_service_code: 'S', courier_name: 'C', courier_service_name: 'S', price } as never,
    ]);
    const mayar = {
      name: 'mayar',
      createPayment: vi.fn(async (_req: object) => ({ ref: 'pay-1', paymentUrl: 'https://pay.example/1' })),
    };
    const tx = {
      order: {
        create: vi.fn(async ({ data }: { data: Record<string, any> }) => ({
          ...data,
          id: 'order-1',
          items: data.items.create.map((i: object) => ({ ...i, id: 'item-1' })),
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      payment: { create: vi.fn(async () => undefined) },
    };
    const service = new OrdersService(
      prisma as never,
      shipping,
      {} as never,
      { current: mayar } as never,
      fx as never,
      { sendInBackground: vi.fn() } as never,
      { get: vi.fn(), getOrThrow: vi.fn(() => 'http://fe') } as never,
    );
    return { service, shipping, mayar, prisma };
  };

  const order = {
    customer_name: 'Test',
    customer_email: 'test@example.com',
    address: '1 Marina Boulevard',
    city: 'Singapore',
    state: 'Singapore',
    district: 'Downtown',
    sub_district: 'Marina',
    postal_code: '018989',
    courier_code: 'C',
    courier_service: 'S',
    items: [],
  };
  const abroad = { ...order, country_code: 'SG', currency: 'USD', customer_phone: '+65 8123 4567' };
  const domestic = { ...order, country_code: 'ID', currency: 'IDR', customer_phone: '081234567890' };

  it('limits buyers abroad to cards', async () => {
    const { service, mayar } = paySetup(1234);
    await service.checkout(abroad as never);
    expect(mayar.createPayment.mock.calls[0][0]).toMatchObject({ cardOnly: true });
  });

  it('keeps every payment method for Indonesia', async () => {
    const { service, mayar } = paySetup(15000);
    await service.checkout(domestic as never);
    expect(mayar.createPayment.mock.calls[0][0]).toMatchObject({ cardOnly: false });
  });

  it('returns the hosted payment page and stores which gateway made it', async () => {
    const { service, prisma } = paySetup(15000);
    await expect(service.checkout(domestic as never)).resolves.toMatchObject({
      payment_url: 'https://pay.example/1',
    });
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        gateway: 'mayar',
        gatewayRef: 'pay-1',
        redirectUrl: 'https://pay.example/1',
      }),
    });
  });

  it('charges exactly the IDR amount shown before paying', async () => {
    const { service, shipping, mayar } = paySetup(1234);

    const [shown] = await shipping.rates({ ...abroad, items: [] } as never);
    await service.checkout(abroad as never);

    expect(mayar.createPayment.mock.calls[0][0]).toMatchObject({
      amount: (shown as unknown as { charge_idr: number }).charge_idr,
    });
  });
});

describe('MayarService.createPayment', () => {
  const mayar = new MayarService({
    get: vi.fn(),
    getOrThrow: vi.fn(() => 'value'),
  } as unknown as ConfigService);
  const req = {
    orderNo: 'OD-1',
    amount: 1000,
    items: [{ id: 'p', name: 'Tee', price: 1000, quantity: 1 }],
    customer: { name: 'A', email: 'a@b.c', phone: '1' },
  };
  const call = async (reply: object, status = 200) => {
    const fetchMock = vi.fn(
      async (_url: string, _init: { body: string }) => new Response(JSON.stringify(reply), { status }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await mayar.createPayment(req);
      return { result, body: JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown> };
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it('closes the page 10 minutes after checkout and returns to the order', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-31T17:30:05Z'), toFake: ['Date'] });
    const { body, result } = await call({ statusCode: 200, data: { id: 'pay-1', link: 'https://l' } });
    vi.useRealTimers();
    expect(body).toMatchObject({
      amount: 1000,
      expiredAt: '2026-10-31T17:40:05.000Z',
      redirectUrl: 'value/orders/success?order_no=OD-1',
    });
    expect(result).toEqual({ ref: 'pay-1', paymentUrl: 'https://l' });
  });

  it('fails the checkout when Mayar refuses', async () => {
    await expect(call({ statusCode: 400, messages: 'bad' }, 400)).rejects.toThrow('Could not create payment');
  });
});

describe('MayarService.resolveOutcome', () => {
  const mayar = new MayarService({ get: vi.fn() } as unknown as ConfigService);
  it.each([
    ['paid', 'PAID'],
    ['closed', 'FAILED'],
    ['unpaid', 'PENDING'],
  ])('maps %s to %s', (status, outcome) => {
    expect(mayar.resolveOutcome(status)).toBe(outcome);
  });
});

describe('OrdersService.ship', () => {
  const shipSetup = (shippingType: 'DOMESTIC' | 'INTERNATIONAL') => {
    const order = {
      id: 'order-1',
      orderNo: 'OD-1',
      status: OrderStatus.CONFIRMED,
      shippingType,
      courierName: 'Asia Zone',
      items: [],
    };
    const update = vi.fn(async ({ data }: { data: object }) => ({ ...order, ...data }));
    const biteship = {
      createOrder: vi.fn(async () => ({ biteshipId: 'bs', waybill: 'W', trackingId: 'T', trackingUrl: null })),
    };
    const shipping = { requireOrigin: vi.fn(async () => ({ contactName: 'Sender' })) };
    const service = new OrdersService(
      { order: { findUnique: vi.fn(async () => order), update } } as never,
      shipping as never,
      biteship as never,
      {} as never,
      {} as never,
      { sendInBackground: vi.fn() } as never,
      { get: vi.fn(), getOrThrow: vi.fn(() => 'http://fe') } as never,
    );
    return { service, biteship, update };
  };

  it('keeps international shipments away from Biteship and stores the document', async () => {
    const { service, biteship, update } = shipSetup('INTERNATIONAL');

    await service.ship(
      'order-1',
      {
        courier_name: 'DHL',
        tracking_number: 'DHL1',
        shipping_document_url: 'https://files.example/awb.pdf',
      },
      'admin',
    );

    expect(biteship.createOrder).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data).toMatchObject({
      waybill: 'DHL1',
      shippingDocumentUrl: 'https://files.example/awb.pdf',
    });
  });

  it('books domestic shipments through Biteship', async () => {
    const { service, biteship } = shipSetup('DOMESTIC');
    await service.ship('order-1', {}, 'admin');
    expect(biteship.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ origin: { contactName: 'Sender' } }),
    );
  });
});

describe('OrdersService.expireStaleOrders', () => {
  it('expires an order Mayar has no payment for and restores its stock', async () => {
    const { service, mayar, order, logs, stock } = setup();
    mayar.getStatus.mockResolvedValue(null);

    await service.expireStaleOrders();

    expect(order.status).toBe(OrderStatus.EXPIRED);
    expect(stock()).toBe(7);
    expect(logs).toEqual([
      expect.objectContaining({ status: OrderStatus.EXPIRED, note: 'Payment window expired' }),
    ]);
  });

  it('emails the buyer once when the window ends', async () => {
    const { service, mayar, mail, order } = setup();
    mayar.getStatus.mockResolvedValue(null);
    Object.assign(order, { customerEmail: 'buyer@example.com' });

    await service.expireStaleOrders();
    await service.expireStaleOrders();

    expect(mail.sendInBackground).toHaveBeenCalledTimes(1);
    expect(mail.sendInBackground.mock.calls[0][3]).toMatchObject({ statusLabel: 'Expired' });
  });

  it('only looks at pending orders two minutes past the 10 minute window', async () => {
    const { service, mayar, prisma } = setup();
    mayar.getStatus.mockResolvedValue(null);

    await service.expireStaleOrders();

    const { where } = (prisma.order.findMany.mock.calls as unknown as [[{ where: any }]])[0][0];
    expect(where.status).toBe(OrderStatus.PENDING_PAYMENT);
    const age = Date.now() - (where.createdAt.lt as Date).getTime();
    expect(age).toBeGreaterThanOrEqual(12 * 60 * 1000 - 1000);
    expect(age).toBeLessThanOrEqual(12 * 60 * 1000 + 1000);
  });

  it('closes a still-unpaid payment page and expires the order', async () => {
    const { service, mayar, order, stock } = setup();
    mayar.getStatus.mockResolvedValue(unpaid);

    await service.expireStaleOrders();

    expect(mayar.close).toHaveBeenCalledWith('pay-1');
    expect(order.status).toBe(OrderStatus.EXPIRED);
    expect(stock()).toBe(7);
  });

  it('marks an order paid when the payment landed without a webhook', async () => {
    const { service, mayar, order } = setup();
    mayar.getStatus.mockResolvedValue(paid);

    await service.expireStaleOrders();

    expect(mayar.close).not.toHaveBeenCalled();
    expect(order.status).toBe(OrderStatus.PAID);
  });

  it('keeps the order pending when Mayar cannot be reached', async () => {
    const { service, mayar, order, stock } = setup();
    mayar.getStatus.mockRejectedValue(new Error('Mayar status failed'));

    await expect(service.expireStaleOrders()).resolves.toBeUndefined();

    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(stock()).toBe(5);
  });

  it('restores stock once when the job and a webhook close the same order', async () => {
    const { service, mayar, prisma, stock, logs } = setup();
    mayar.getStatus.mockResolvedValue(null);
    await service.expireStaleOrders();

    // A webhook that already read the order as pending, closing it a second time
    const closeUnpaid = (service as unknown as Record<string, Function>).closeUnpaid.bind(service);
    await closeUnpaid(prisma, 'order-1', OrderStatus.CANCELLED, 'Payment cancel');

    expect(stock()).toBe(7);
    expect(logs).toHaveLength(1);
  });
});

describe('OrdersService.handleBiteshipWebhook', () => {
  it('stores waybill details that arrive after booking', async () => {
    const { service, order } = setup();

    await service.handleBiteshipWebhook({
      order_id: 'bs-1',
      status: 'confirmed',
      courier_waybill_id: 'WYB-1',
      courier_tracking_id: 'TRK-1',
      courier_link: 'https://track.example/1',
    });

    expect(order).toMatchObject({
      waybill: 'WYB-1',
      trackingId: 'TRK-1',
      trackingUrl: 'https://track.example/1',
    });
  });

  it('does not wipe known details when an event omits them', async () => {
    const { service, order } = setup();
    order.trackingUrl = 'https://track.example/1';

    await service.handleBiteshipWebhook({ order_id: 'bs-1', status: 'picked', courier_link: null });

    expect(order.trackingUrl).toBe('https://track.example/1');
  });

  const shipped = () => {
    const ctx = setup();
    const logs: { note: string }[] = [];
    Object.assign(ctx.order, { status: OrderStatus.SHIPPED, customerEmail: 'buyer@example.com' });
    ctx.prisma.order.findFirst.mockImplementation(async () => ({ ...ctx.order, items: [], payment: null, logs }));
    ctx.prisma.orderStatusLog.create.mockImplementation(async ({ data }) => {
      logs.push(data);
    });
    return { ...ctx, statusLogs: logs };
  };
  const sentNotes = (mail: { sendInBackground: ReturnType<typeof vi.fn> }) =>
    mail.sendInBackground.mock.calls.map((c) => (c[3] as { note: string }).note);

  it.each(['picked', 'in_transit', 'dropping_off'])('emails the buyer once on %s', async (status) => {
    const { service, mail, statusLogs } = shipped();

    await service.handleBiteshipWebhook({ order_id: 'bs-1', status });
    await service.handleBiteshipWebhook({ order_id: 'bs-1', status });

    expect(mail.sendInBackground).toHaveBeenCalledTimes(1);
    expect(sentNotes(mail)[0]).toContain('picked up by the courier');
    expect(statusLogs).toHaveLength(1);
  });

  it('does not email again when later statuses follow the pickup', async () => {
    const { service, mail } = shipped();

    await service.handleBiteshipWebhook({ order_id: 'bs-1', status: 'picked' });
    await service.handleBiteshipWebhook({ order_id: 'bs-1', status: 'in_transit' });
    await service.handleBiteshipWebhook({ order_id: 'bs-1', status: 'dropping_off' });

    expect(mail.sendInBackground).toHaveBeenCalledTimes(1);
  });

  it.each(['confirmed', 'allocated', 'picking_up'])('stays quiet before the pickup on %s', async (status) => {
    const { service, mail } = shipped();

    await service.handleBiteshipWebhook({ order_id: 'bs-1', status });

    expect(mail.sendInBackground).not.toHaveBeenCalled();
  });

  it('marks the order delivered and tells the buyer', async () => {
    const { service, mail, order } = shipped();

    await service.handleBiteshipWebhook({ order_id: 'bs-1', status: 'delivered' });

    expect(order.status).toBe(OrderStatus.DELIVERED);
    expect(sentNotes(mail)[0]).toContain('delivered');
  });

  it('ignores updates for orders that were not shipped', async () => {
    const { service, mail, prisma } = shipped();
    prisma.order.findFirst.mockResolvedValue(null);

    await service.handleBiteshipWebhook({ order_id: 'bs-1', status: 'picked' });

    expect(mail.sendInBackground).not.toHaveBeenCalled();
  });
});

describe('MayarService.getStatus', () => {
  const mayar = new MayarService({
    get: vi.fn(),
    getOrThrow: vi.fn(() => 'api-key'),
  } as unknown as ConfigService);
  const reply = (status: number, body: object) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('treats HTTP 404 as no payment', async () => {
    reply(404, { statusCode: 404, messages: 'Not Found' });
    await expect(mayar.getStatus('pay-1')).resolves.toBeNull();
  });

  it('treats a 404 inside an HTTP 200 body as no payment', async () => {
    reply(200, { statusCode: 404, messages: 'Not Found' });
    await expect(mayar.getStatus('pay-1')).resolves.toBeNull();
  });

  it('returns the payment when there is one', async () => {
    reply(200, { statusCode: 200, messages: 'success', data: { id: 'pay-1', status: 'paid' } });
    await expect(mayar.getStatus('pay-1')).resolves.toMatchObject({ status: 'paid', outcome: 'PAID' });
  });

  it('throws on auth failures so a wrong key never expires orders', async () => {
    reply(401, { statusCode: 401, messages: 'Unauthorized' });
    await expect(mayar.getStatus('pay-1')).rejects.toThrow('Mayar status failed');
  });
});

describe('MidtransService', () => {
  const midtrans = new MidtransService({
    get: vi.fn(),
    getOrThrow: vi.fn(() => 'value'),
  } as unknown as ConfigService);
  const req = {
    orderNo: 'OD-1',
    amount: 1000,
    items: [],
    customer: { name: 'A', email: 'a@b.c', phone: '1' },
  };
  afterEach(() => vi.unstubAllGlobals());

  const createBody = async (extra: object) => {
    const fetchMock = vi.fn(
      async (_url: string, _init: { body: string }) =>
        new Response(JSON.stringify({ token: 't', redirect_url: 'https://snap/r' }), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await midtrans.createPayment({ ...req, ...extra });
    return { result, body: JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown> };
  };

  it('limits Snap to cards for buyers abroad and keys the payment by order number', async () => {
    const { result, body } = await createBody({ cardOnly: true });
    expect(body).toMatchObject({ enabled_payments: ['credit_card'] });
    expect(result).toEqual({ ref: 'OD-1', paymentUrl: 'https://snap/r' });
  });

  it('offers every method otherwise', async () => {
    expect((await createBody({})).body).not.toHaveProperty('enabled_payments');
  });

  it('starts the 10 minute clock at checkout, in Jakarta time', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-31T17:30:05Z'), toFake: ['Date'] });
    const { body } = await createBody({});
    vi.useRealTimers();
    expect(body.expiry).toEqual({ start_time: '2026-11-01 00:30:05 +0700', unit: 'minutes', duration: 10 });
  });

  it('treats a 404 inside an HTTP 200 body as no transaction', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status_code: '404' }), { status: 200 })));
    await expect(midtrans.getStatus('OD-1')).resolves.toBeNull();
  });

  it('reports an expired transaction as expired', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status_code: '407', transaction_status: 'expire' }), { status: 200 }),
      ),
    );
    await expect(midtrans.getStatus('OD-1')).resolves.toMatchObject({ outcome: 'FAILED', expired: true });
  });
});

describe('PaymentGatewaysService', () => {
  const mayar = { name: 'mayar' } as never;
  const midtrans = { name: 'midtrans' } as never;
  const pick = (value?: string) =>
    new PaymentGatewaysService({ get: vi.fn(() => value) } as unknown as ConfigService, mayar, midtrans);

  it('uses Mayar by default', () => {
    expect(pick().current).toBe(mayar);
  });

  it('switches to Midtrans from the env', () => {
    expect(pick(' Midtrans ').current).toBe(midtrans);
  });

  it('refuses an unknown gateway instead of silently using another', () => {
    expect(() => pick('xendit').current).toThrow('PAYMENT_GATEWAY');
  });

  it('keeps routing stored payments to the gateway that created them', () => {
    expect(pick('mayar').get('midtrans')).toBe(midtrans);
  });
});
