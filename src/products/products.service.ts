import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { paginate } from '../common/dto/pagination.dto.js';
import { uniqueSlug } from '../common/utils/slug.js';
import { PreOrderMode, ProductAvailability } from '../generated/prisma/enums.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  CreateProductDto,
  ProductDiscountDto,
  ProductQueryDto,
  ProductSizeDto,
  UpdateProductDto,
} from './dto/product.dto.js';

const include = {
  category: { select: { id: true, name: true, slug: true } },
  images: { orderBy: { sort: 'asc' } },
  sizes: { orderBy: { sort: 'asc' } },
  discounts: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.ProductInclude;

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ProductQueryDto, publicOnly: boolean) {
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      ...(publicOnly ? { isActive: true } : query.is_active !== undefined && { isActive: query.is_active }),
      ...(query.availability && { availability: query.availability }),
      ...(query.category && { category: { slug: query.category } }),
      ...(query.search && { name: { contains: query.search, mode: 'insensitive' } }),
    };
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.product.count({ where }),
    ]);
    return paginate(items, total, query);
  }

  async findBySlug(slug: string) {
    const product = await this.prisma.product.findFirst({
      where: { slug, deletedAt: null, isActive: true },
      include,
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async findById(id: string) {
    const product = await this.prisma.product.findFirst({ where: { id, deletedAt: null }, include });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  create(dto: CreateProductDto) {
    return this.prisma.product.create({
      data: {
        ...this.toData(dto),
        name: dto.name,
        price: dto.price,
        priceUsdCents: dto.price_usd_cents,
        weightGram: dto.weight_gram,
        stock: this.totalStock(dto) ?? dto.stock,
        availability: dto.availability,
        slug: uniqueSlug(dto.name),
        images: { create: this.toImages(dto.images) },
        ...(dto.discounts?.length && {
          discounts: { create: dto.discounts.map((d) => this.toDiscount(d)) },
        }),
        ...(dto.sizes?.length && {
          sizes: {
            create: dto.sizes.map((s, sort) => ({ label: s.label, stock: s.stock, sort })),
          },
        }),
      },
      include,
    });
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.findById(id);
    return this.prisma.$transaction(async (tx) => {
      if (dto.sizes) await this.syncSizes(tx, id, dto.sizes);
      if (dto.discounts) await this.syncDiscounts(tx, id, dto.discounts);
      return tx.product.update({
        where: { id },
        data: {
          ...this.toData(dto),
          name: dto.name,
          ...(this.totalStock(dto) !== undefined && { stock: this.totalStock(dto) }),
          ...(dto.images && { images: { deleteMany: {}, create: this.toImages(dto.images) } }),
        },
        include,
      });
    });
  }

  /**
   * Updates sizes in place (matched by id) instead of recreating them, so past
   * order items keep their size reference. Removed sizes are deleted; their
   * order items keep the label snapshot.
   */
  private async syncSizes(tx: Prisma.TransactionClient, productId: string, sizes: ProductSizeDto[]) {
    const keepIds = sizes.flatMap((s) => (s.id ? [s.id] : []));
    await tx.productSize.deleteMany({ where: { productId, id: { notIn: keepIds } } });
    // Two-phase relabel avoids clashing with the (productId, label) unique index when sizes swap labels.
    // Temp labels must fit VARCHAR(20); real labels are uppercased, so lowercase "~tmp" can't collide.
    for (const [i, s] of sizes.filter((s) => s.id).entries()) {
      await tx.productSize.update({ where: { id: s.id, productId }, data: { label: `~tmp${i}` } });
    }
    for (const [sort, s] of sizes.entries()) {
      if (s.id) {
        await tx.productSize.update({
          where: { id: s.id, productId },
          data: { label: s.label, stock: s.stock, sort },
        });
      } else {
        await tx.productSize.create({ data: { productId, label: s.label, stock: s.stock, sort } });
      }
    }
  }

  private async syncDiscounts(
    tx: Prisma.TransactionClient,
    productId: string,
    discounts: ProductDiscountDto[],
  ) {
    const keepIds = discounts.flatMap((d) => (d.id ? [d.id] : []));
    await tx.productDiscount.deleteMany({ where: { productId, id: { notIn: keepIds } } });
    for (const d of discounts) {
      const data = this.toDiscount(d);
      if (d.id) await tx.productDiscount.update({ where: { id: d.id, productId }, data });
      else await tx.productDiscount.create({ data: { ...data, productId } });
    }
  }

  private toDiscount(d: ProductDiscountDto) {
    const startAt = d.start_at ? new Date(d.start_at) : null;
    const endAt = d.end_at ? new Date(d.end_at) : null;
    if (startAt && endAt && endAt <= startAt) {
      throw new BadRequestException(`Discount "${d.name}" must end after it starts`);
    }
    return { name: d.name, discountPct: d.discount_pct, startAt, endAt, isActive: d.is_active };
  }

  /** With sizes, product stock is their sum; undefined means "use dto.stock". */
  private totalStock(dto: UpdateProductDto) {
    return dto.sizes?.length ? dto.sizes.reduce((sum, s) => sum + s.stock, 0) : undefined;
  }

  async remove(id: string) {
    await this.findById(id);
    await this.prisma.product.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
  }

  private toData(dto: UpdateProductDto) {
    return {
      description: dto.description,
      categoryId: dto.category_id,
      price: dto.price,
      priceUsdCents: dto.price_usd_cents,
      weightGram: dto.weight_gram,
      stock: dto.stock,
      availability: dto.availability,
      poEstimateDays:
        dto.availability === ProductAvailability.READY ? null : dto.po_estimate_days,
      ...this.toPreOrderWindow(dto),
      isActive: dto.is_active,
    };
  }

  /** Ready stock clears PO settings; ANYTIME pre-orders have no window. */
  private toPreOrderWindow(dto: UpdateProductDto) {
    if (dto.availability === undefined) return {};
    if (dto.availability === ProductAvailability.READY) {
      return { poMode: null, poStartAt: null, poEndAt: null };
    }
    if (dto.po_mode === PreOrderMode.PERIOD) {
      const start = new Date(dto.po_start_at!);
      const end = new Date(dto.po_end_at!);
      if (end <= start) throw new BadRequestException('Pre-order end must be after its start');
      return { poMode: PreOrderMode.PERIOD, poStartAt: start, poEndAt: end };
    }
    return { poMode: PreOrderMode.ANYTIME, poStartAt: null, poEndAt: null };
  }

  private toImages(images: CreateProductDto['images']) {
    return images.map((img, sort) => ({ url: img.url, fileId: img.file_id, sort }));
  }
}
