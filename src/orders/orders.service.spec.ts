import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { OrderStatus, ProductAvailability } from '../generated/prisma/enums.js';
import { ShippingService } from '../shipping/shipping.service.js';
import { MidtransService } from './midtrans.service.js';
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
      findMany: vi.fn(async () => (order.status === OrderStatus.PENDING_PAYMENT ? [order] : [])),
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
    payment: { update: vi.fn(async () => undefined) },
  };
  const prisma = {
    ...client,
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function' ? arg(client) : Promise.all(arg as unknown[]),
    ),
  };
  const midtrans = {
    getStatus: vi.fn(),
    verifySignature: vi.fn(() => true),
    resolveOutcome: vi.fn(() => 'FAILED'),
  };
  const mail = { sendInBackground: vi.fn() };
  const service = new OrdersService(
    prisma as never,
    {} as never,
    {} as never,
    midtrans as never,
    {} as never,
    mail as never,
    { get: vi.fn(), getOrThrow: vi.fn(() => 'http://fe') } as never,
  );
  return { service, midtrans, mail, prisma, order, logs, stock: () => stock };
};

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

describe('OrdersService.handleMidtransNotification', () => {
  it('accepts a signed notification for an unknown order, like the dashboard test', async () => {
    const { service, prisma } = setup();
    prisma.order.findUnique.mockResolvedValue(null);

    await expect(
      service.handleMidtransNotification({ order_id: 'payment_notif_test' } as never),
    ).resolves.toBeUndefined();

    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('still rejects a bad signature', async () => {
    const { service, midtrans } = setup();
    midtrans.verifySignature.mockReturnValue(false);

    await expect(
      service.handleMidtransNotification({ order_id: 'OD-1' } as never),
    ).rejects.toThrow('Invalid signature');
  });
});

describe('OrdersService.cancel', () => {
  const dto = { order_no: 'od-1', email: 'Buyer@Example.com' };
  const cancelSetup = () => {
    const ctx = setup();
    Object.assign(ctx.midtrans, { cancel: vi.fn(async () => undefined) });
    ctx.prisma.order.findFirst.mockImplementation(
      async () => ({ ...ctx.order, customerEmail: 'buyer@example.com', items: [], logs: [], payment: null }) as never,
    );
    return ctx;
  };

  it('cancels an order Midtrans never saw and restores stock', async () => {
    const { service, midtrans, order, stock, logs } = cancelSetup();
    midtrans.getStatus.mockResolvedValue(null);

    await service.cancel(dto);

    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(stock()).toBe(7);
    expect(logs[0].note).toBe('Cancelled by buyer');
    expect((midtrans as unknown as { cancel: unknown }).cancel).not.toHaveBeenCalled();
  });

  it('voids a pending transaction before closing the order', async () => {
    const { service, midtrans, order } = cancelSetup();
    midtrans.getStatus.mockResolvedValue({ transaction_status: 'pending' });
    midtrans.resolveOutcome.mockReturnValue('PENDING');

    await service.cancel(dto);

    expect((midtrans as unknown as { cancel: unknown }).cancel).toHaveBeenCalledWith('OD-1');
    expect(order.status).toBe(OrderStatus.CANCELLED);
  });

  it('keeps the order open when Midtrans refuses the void', async () => {
    const { service, midtrans, order, stock } = cancelSetup();
    midtrans.getStatus.mockResolvedValue({ transaction_status: 'pending' });
    midtrans.resolveOutcome.mockReturnValue('PENDING');
    (midtrans as unknown as { cancel: ReturnType<typeof vi.fn> }).cancel.mockRejectedValue(new Error('nope'));

    await expect(service.cancel(dto)).rejects.toThrow('nope');

    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(stock()).toBe(5);
  });

  it('refuses when the payment already landed and records it', async () => {
    const { service, midtrans, order, stock } = cancelSetup();
    midtrans.getStatus.mockResolvedValue({ order_id: 'OD-1', transaction_status: 'settlement' });
    midtrans.resolveOutcome.mockReturnValue('PAID');

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
    const { service, midtrans, order, logs, prisma } = setup();
    order.status = OrderStatus.CANCELLED;
    midtrans.resolveOutcome.mockReturnValue('PAID');
    const notification = { order_id: 'OD-1', transaction_status: 'settlement' };

    await service.handleMidtransNotification(notification as never);
    expect(logs[0].note).toContain('refund');

    prisma.order.findUnique.mockImplementation(
      async () => ({ ...order, items: [], payment: { transactionStatus: 'settlement' } }) as never,
    );
    await service.handleMidtransNotification(notification as never);
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
    const midtrans = {
      clientKey: 'client',
      createSnap: vi.fn(async (_req: object) => ({ token: 't', redirectUrl: null })),
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
      midtrans as never,
      fx as never,
      { sendInBackground: vi.fn() } as never,
      { get: vi.fn(), getOrThrow: vi.fn(() => 'http://fe') } as never,
    );
    return { service, shipping, midtrans };
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
    const { service, midtrans } = paySetup(1234);
    await service.checkout(abroad as never);
    expect(midtrans.createSnap.mock.calls[0][0]).toMatchObject({ enabledPayments: ['credit_card'] });
  });

  it('keeps every payment method for Indonesia', async () => {
    const { service, midtrans } = paySetup(15000);
    await service.checkout(domestic as never);
    expect(midtrans.createSnap.mock.calls[0][0]).not.toHaveProperty('enabledPayments');
  });

  it('charges exactly the IDR amount shown before paying', async () => {
    const { service, shipping, midtrans } = paySetup(1234);

    const [shown] = await shipping.rates({ ...abroad, items: [] } as never);
    await service.checkout(abroad as never);

    expect(midtrans.createSnap.mock.calls[0][0]).toMatchObject({
      grossAmount: (shown as unknown as { charge_idr: number }).charge_idr,
    });
  });
});

describe('MidtransService.createSnap', () => {
  const midtrans = new MidtransService({
    get: vi.fn(),
    getOrThrow: vi.fn(() => 'value'),
  } as unknown as ConfigService);
  const snap = { orderNo: 'OD-1', grossAmount: 1000, items: [], customer: { name: 'A', email: 'a@b.c', phone: '1' } };
  const bodyOf = async (req: object) => {
    const fetchMock = vi.fn(
      async (_url: string, _init: { body: string }) =>
        new Response(JSON.stringify({ token: 't' }), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await midtrans.createSnap({ ...snap, ...req });
    vi.unstubAllGlobals();
    return JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown>;
  };

  it('sends enabled_payments when limited', async () => {
    expect(await bodyOf({ enabledPayments: ['credit_card'] })).toMatchObject({
      enabled_payments: ['credit_card'],
    });
  });

  it('leaves it out otherwise', async () => {
    expect(await bodyOf({})).not.toHaveProperty('enabled_payments');
  });

  it('starts the 10 minute clock at checkout, in Jakarta time', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-31T17:30:05Z'), toFake: ['Date'] });
    const body = await bodyOf({});
    vi.useRealTimers();
    expect(body.expiry).toEqual({
      start_time: '2026-11-01 00:30:05 +0700',
      unit: 'minutes',
      duration: 10,
    });
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
  it('expires an order Midtrans has no transaction for and restores its stock', async () => {
    const { service, midtrans, order, logs, stock } = setup();
    midtrans.getStatus.mockResolvedValue(null);

    await service.expireStaleOrders();

    expect(order.status).toBe(OrderStatus.EXPIRED);
    expect(stock()).toBe(7);
    expect(logs).toEqual([
      expect.objectContaining({ status: OrderStatus.EXPIRED, note: 'Payment window expired' }),
    ]);
  });

  it('emails the buyer once when the window ends', async () => {
    const { service, midtrans, mail, order } = setup();
    midtrans.getStatus.mockResolvedValue(null);
    Object.assign(order, { customerEmail: 'buyer@example.com' });

    await service.expireStaleOrders();
    await service.expireStaleOrders();

    expect(mail.sendInBackground).toHaveBeenCalledTimes(1);
    expect(mail.sendInBackground.mock.calls[0][3]).toMatchObject({ statusLabel: 'Expired' });
  });

  it('only looks at pending orders two minutes past the 10 minute window', async () => {
    const { service, midtrans, prisma } = setup();
    midtrans.getStatus.mockResolvedValue(null);

    await service.expireStaleOrders();

    const { where } = (prisma.order.findMany.mock.calls as unknown as [[{ where: any }]])[0][0];
    expect(where.status).toBe(OrderStatus.PENDING_PAYMENT);
    const age = Date.now() - (where.createdAt.lt as Date).getTime();
    expect(age).toBeGreaterThanOrEqual(12 * 60 * 1000 - 1000);
    expect(age).toBeLessThanOrEqual(12 * 60 * 1000 + 1000);
  });

  it('sends a known transaction through the notification flow', async () => {
    const { service, midtrans, order } = setup();
    midtrans.getStatus.mockResolvedValue({ order_id: 'OD-1', transaction_status: 'expire' });

    await service.expireStaleOrders();

    expect(midtrans.verifySignature).toHaveBeenCalled();
    expect(order.status).toBe(OrderStatus.EXPIRED);
  });

  it('keeps the order pending when Midtrans cannot be reached', async () => {
    const { service, midtrans, order, stock } = setup();
    midtrans.getStatus.mockRejectedValue(new Error('Midtrans status failed'));

    await expect(service.expireStaleOrders()).resolves.toBeUndefined();

    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(stock()).toBe(5);
  });

  it('restores stock once when the job and a webhook close the same order', async () => {
    const { service, midtrans, prisma, stock, logs } = setup();
    midtrans.getStatus.mockResolvedValue(null);
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
});

describe('MidtransService.getStatus', () => {
  const midtrans = new MidtransService({
    get: vi.fn(),
    getOrThrow: vi.fn(() => 'server-key'),
  } as unknown as ConfigService);
  const reply = (status: number, body: object) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('treats HTTP 404 as no transaction', async () => {
    reply(404, { status_code: '404' });
    await expect(midtrans.getStatus('OD-1')).resolves.toBeNull();
  });

  it('treats a 404 inside an HTTP 200 body as no transaction', async () => {
    reply(200, { status_code: '404', status_message: 'not found' });
    await expect(midtrans.getStatus('OD-1')).resolves.toBeNull();
  });

  it('returns the transaction when there is one', async () => {
    reply(200, { status_code: '200', transaction_status: 'settlement' });
    await expect(midtrans.getStatus('OD-1')).resolves.toMatchObject({
      transaction_status: 'settlement',
    });
  });

  it('throws on auth failures so a wrong key never expires orders', async () => {
    reply(401, { status_code: '401' });
    await expect(midtrans.getStatus('OD-1')).rejects.toThrow('Midtrans status failed');
  });
});
