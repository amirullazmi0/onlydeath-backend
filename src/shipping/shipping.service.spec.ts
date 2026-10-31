import { describe, expect, it, vi } from 'vitest';
import { ShippingService } from './shipping.service.js';

const areas = [
  {
    id: 'a',
    name: 'Setia Budi, Jakarta Selatan, DKI Jakarta. 12950',
    postal_code: 12950,
    administrative_division_level_2_name: 'Jakarta Selatan',
    administrative_division_level_3_name: 'Setia Budi',
  },
];

const setup = (result = areas) =>
  new ShippingService({} as never, { searchAreas: vi.fn(async () => result) } as never, {} as never);

describe('ShippingService delivery channels', () => {
  const origin = { contactName: 'Sender', phone: '0812', address: 'Jl. Test', postalCode: '40163' };
  const line = { product: { name: 'Tee', price: 100, weightGram: 500 }, quantity: 1, discountPct: 0 };
  const zone = { id: 'z', name: 'Asia', baseRateCents: 500, perKgRateCents: 100, etaText: '7 days' };

  const channels = () => {
    const biteship = { rates: vi.fn(async () => []), searchAreas: vi.fn() };
    const prisma = {
      storeOrigin: { findUnique: vi.fn(async () => origin) },
      shippingZone: { findMany: vi.fn(async () => [zone]) },
    };
    return {
      biteship,
      prisma,
      service: new ShippingService(prisma as never, biteship as never, {} as never),
    };
  };

  it('quotes Indonesia through Biteship from the saved origin', async () => {
    const { service, biteship, prisma } = channels();
    await service.quote({ country_code: 'ID', postal_code: '12950' }, [line] as never);
    expect(biteship.rates).toHaveBeenCalledWith(origin, expect.anything(), expect.anything());
    expect(prisma.shippingZone.findMany).not.toHaveBeenCalled();
  });

  it('never calls Biteship for other countries', async () => {
    const { service, biteship } = channels();
    const rates = await service.quote({ country_code: 'SG', postal_code: '018989' }, [line] as never);
    expect(biteship.rates).not.toHaveBeenCalled();
    expect(rates[0]).toMatchObject({ courier_code: 'INTL', currency: 'USD', price: 600 });
  });

  it('refuses a domestic quote until the sender address is saved', async () => {
    const { service, prisma } = channels();
    prisma.storeOrigin.findUnique.mockResolvedValue(null as never);
    await expect(
      service.quote({ country_code: 'ID', postal_code: '12950' }, [line] as never),
    ).rejects.toThrow('Shipping origin is not set yet');
  });
});

describe('ShippingService.assertDomesticAddress', () => {
  const address = { postal_code: '12950', city: 'KOTA JAKARTA SELATAN', district: 'SETIA BUDI' };

  it('accepts a postal code inside the chosen region', async () => {
    await expect(setup().assertDomesticAddress(address)).resolves.toBeUndefined();
  });

  it('rejects a postal code Biteship does not know', async () => {
    await expect(setup([]).assertDomesticAddress(address)).rejects.toThrow('Postal code not found');
  });

  it('rejects a postal code from another city', async () => {
    await expect(
      setup().assertDomesticAddress({ ...address, city: 'KOTA BANDUNG', district: 'SUMUR BANDUNG' }),
    ).rejects.toThrow('does not match');
  });

  it('accepts a differently spelled kecamatan when the city matches', async () => {
    await expect(
      setup().assertDomesticAddress({ ...address, district: 'SETIABUDI RAYA' }),
    ).resolves.toBeUndefined();
  });

  it('accepts a differently spelled city when the kecamatan matches', async () => {
    await expect(
      setup().assertDomesticAddress({ ...address, city: 'KOTA ADM. JAKSEL' }),
    ).resolves.toBeUndefined();
  });

  it('ignores punctuation in region names', async () => {
    const baubau = [{ ...areas[0], administrative_division_level_2_name: 'Bau-Bau' }];
    await expect(
      setup(baubau).assertDomesticAddress({ ...address, city: 'KOTA BAUBAU', district: 'WOLIO' }),
    ).resolves.toBeUndefined();
  });
});
