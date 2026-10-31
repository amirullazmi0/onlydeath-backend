import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Currency, PreOrderMode, ProductAvailability } from '../generated/prisma/enums.js';
import { BiteshipService, CourierRate } from './biteship.service.js';
import { FxService } from '../fx/fx.service.js';
import { activeDiscountPct, applyDiscount } from '../products/pricing.js';
import {
  CartItemDto,
  CreateShippingZoneDto,
  RatesDto,
  UpdateShippingOriginDto,
  UpdateShippingZoneDto,
} from './dto/shipping.dto.js';

/** courier_code used for zone-based international rates (courier_service_code = zone id). */
export const INTERNATIONAL_COURIER = 'INTL';

/** Rate price is in minor units of its currency: IDR for Indonesia, USD cents abroad. */
export type QuotedRate = CourierRate & { currency: Currency };

type CartLine = Awaited<ReturnType<ShippingService['resolveCart']>>[number];

/** "KOTA BAU-BAU" and "Baubau" are the same place in the two region datasets. */
const regionKey = (name = '') =>
  name
    .toUpperCase()
    .replace(/^(KOTA|KABUPATEN|KAB\.?)\s+(ADM\S*\s+)?/, '')
    .replace(/[^A-Z0-9]/g, '');

const sameRegion = (a?: string, b?: string) => {
  const [x, y] = [regionKey(a), regionKey(b)];
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

@Injectable()
export class ShippingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly biteship: BiteshipService,
    private readonly fx: FxService,
  ) {}

  searchAreas(q: string) {
    return this.biteship.searchAreas(q);
  }

  async rates(dto: RatesDto) {
    const lines = await this.resolveCart(dto.items);
    if (dto.country_code === 'ID' && dto.city && dto.district) {
      await this.assertDomesticAddress({
        postal_code: dto.postal_code,
        city: dto.city,
        district: dto.district,
      });
    }
    const rates = await this.quote(dto, lines);
    if (dto.country_code === 'ID') return rates;

    // Buyers abroad see USD but Midtrans charges IDR, so show the amount before they
    // pay. Built per unit like the checkout total, which must match it exactly.
    const fxRate = await this.fx.usdToIdr();
    const goods = lines.reduce(
      (sum, l) =>
        sum +
        this.fx.centsToIdr(applyDiscount(l.product.priceUsdCents, l.discountPct), fxRate) * l.quantity,
      0,
    );
    return rates.map((r) => ({ ...r, charge_idr: goods + this.fx.centsToIdr(r.price, fxRate) }));
  }

  // ---------- Origin (admin) ----------

  getOrigin() {
    return this.prisma.storeOrigin.findUnique({ where: { id: 1 } });
  }

  async requireOrigin() {
    const origin = await this.getOrigin();
    if (!origin) throw new BadRequestException('Shipping origin is not set yet');
    return origin;
  }

  /** The postal code drives every domestic quote, so a wrong one is refused here. */
  async updateOrigin(dto: UpdateShippingOriginDto) {
    const areas = await this.biteship.searchAreas(dto.postal_code);
    if (!areas.some((a) => a.postal_code === Number(dto.postal_code))) {
      throw new BadRequestException('Postal code not found, please check it');
    }
    const data = {
      contactName: dto.contact_name,
      phone: dto.phone,
      address: dto.address,
      postalCode: dto.postal_code,
    };
    return this.prisma.storeOrigin.upsert({
      where: { id: 1 },
      create: { id: 1, ...data },
      update: data,
    });
  }

  /**
   * Shipping cost is quoted by postal code, so it has to belong to the chosen
   * region. Spelling differs between datasets, hence either level may match.
   */
  async assertDomesticAddress(dest: { postal_code: string; city: string; district: string }) {
    const areas = (await this.biteship.searchAreas(dest.postal_code)).filter(
      (a) => a.postal_code === Number(dest.postal_code),
    );
    if (areas.length === 0) {
      throw new BadRequestException('Postal code not found, please check it');
    }
    const matches = areas.some(
      (a) =>
        sameRegion(a.administrative_division_level_2_name, dest.city) ||
        sameRegion(a.administrative_division_level_3_name, dest.district),
    );
    if (!matches) {
      throw new BadRequestException(
        `Postal code ${dest.postal_code} does not match ${dest.district}, ${dest.city}`,
      );
    }
  }

  /**
   * Indonesia uses live Biteship rates; every other country uses the admin's
   * shipping zones (base + per started kg).
   */
  async quote(
    dest: { country_code: string; area_id?: string; postal_code: string },
    lines: CartLine[],
  ): Promise<QuotedRate[]> {
    if (dest.country_code === 'ID') {
      if (!/^\d{5}$/.test(dest.postal_code)) {
        throw new BadRequestException('Indonesian postal codes have 5 digits');
      }
      const rates = await this.biteship.rates(
        await this.requireOrigin(),
        { areaId: dest.area_id, postalCode: dest.postal_code },
        lines.map((l) => ({
          name: l.product.name,
          // Declared value for the courier (insurance) is what the buyer actually pays
          value: applyDiscount(l.product.price, l.discountPct),
          weight: l.product.weightGram,
          quantity: l.quantity,
        })),
      );
      return rates.map((r) => ({ ...r, currency: Currency.IDR }));
    }

    const grams = lines.reduce((sum, l) => sum + l.product.weightGram * l.quantity, 0);
    const kg = Math.max(1, Math.ceil(grams / 1000));
    const zones = await this.prisma.shippingZone.findMany({
      where: { deletedAt: null, isActive: true, countries: { has: dest.country_code } },
      orderBy: { baseRateCents: 'asc' },
    });
    if (zones.length === 0) {
      throw new BadRequestException('Sorry, we do not ship to this country yet');
    }
    return zones.map((z) => ({
      courier_code: INTERNATIONAL_COURIER,
      courier_service_code: z.id,
      courier_name: z.name,
      courier_service_name: 'International',
      description: `${kg} kg`,
      duration: z.etaText,
      currency: Currency.USD,
      price: z.baseRateCents + z.perKgRateCents * kg,
    }));
  }

  /**
   * Loads cart products from the DB (never trust client prices) and validates
   * each line: size required when the product has sizes, READY stock checked
   * per size (or per product), PERIOD pre-orders only while their window is open.
   */
  async resolveCart(items: CartItemDto[]) {
    const merged = new Map<string, CartItemDto>();
    for (const item of items) {
      const key = `${item.product_id}:${item.size_id ?? ''}`;
      const prev = merged.get(key);
      merged.set(key, {
        product_id: item.product_id,
        size_id: item.size_id,
        quantity: (prev?.quantity ?? 0) + item.quantity,
      });
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: [...new Set(items.map((i) => i.product_id))] }, deletedAt: null, isActive: true },
      include: { images: { orderBy: { sort: 'asc' }, take: 1 }, sizes: true, discounts: true },
    });

    const now = new Date();
    return [...merged.values()].map(({ product_id, size_id, quantity }) => {
      const product = products.find((p) => p.id === product_id);
      if (!product) throw new BadRequestException('Some products are no longer available');

      let size: (typeof product.sizes)[number] | null = null;
      if (product.sizes.length > 0) {
        size = product.sizes.find((s) => s.id === size_id) ?? null;
        if (!size) throw new BadRequestException(`Please choose a size for ${product.name}`);
      } else if (size_id) {
        throw new BadRequestException(`${product.name} has no size options`);
      }

      if (product.availability === ProductAvailability.PRE_ORDER) {
        if (product.poMode === PreOrderMode.PERIOD) {
          if (product.poStartAt && now < product.poStartAt) {
            throw new BadRequestException(
              `Pre-order for ${product.name} opens on ${product.poStartAt.toDateString()}`,
            );
          }
          if (product.poEndAt && now > product.poEndAt) {
            throw new BadRequestException(`Pre-order for ${product.name} has closed`);
          }
        }
      } else {
        const available = size ? size.stock : product.stock;
        if (available < quantity) {
          const label = size ? `${product.name} (${size.label})` : product.name;
          throw new BadRequestException(`Not enough stock for ${label} (${available} left)`);
        }
      }
      return { product, size, quantity, discountPct: activeDiscountPct(product.discounts, now) };
    });
  }
  // ---------- Zones (admin) ----------

  listZones() {
    return this.prisma.shippingZone.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
    });
  }

  createZone(dto: CreateShippingZoneDto) {
    return this.prisma.shippingZone.create({
      data: {
        ...this.toZoneData(dto),
        name: dto.name,
        countries: dto.countries,
        baseRateCents: dto.base_rate_cents,
        perKgRateCents: dto.per_kg_rate_cents,
        etaText: dto.eta_text,
      },
    });
  }

  async updateZone(id: string, dto: UpdateShippingZoneDto) {
    await this.findZone(id);
    return this.prisma.shippingZone.update({ where: { id }, data: this.toZoneData(dto) });
  }

  async removeZone(id: string) {
    await this.findZone(id);
    await this.prisma.shippingZone.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private async findZone(id: string) {
    const zone = await this.prisma.shippingZone.findFirst({ where: { id, deletedAt: null } });
    if (!zone) throw new NotFoundException('Shipping zone not found');
    return zone;
  }

  private toZoneData(dto: UpdateShippingZoneDto) {
    if (dto.countries?.includes('ID')) {
      throw new BadRequestException('Indonesia uses Biteship rates and cannot be in a zone');
    }
    return {
      name: dto.name,
      countries: dto.countries,
      baseRateCents: dto.base_rate_cents,
      perKgRateCents: dto.per_kg_rate_cents,
      etaText: dto.eta_text,
      isActive: dto.is_active,
    };
  }
}
