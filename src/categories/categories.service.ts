import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { uniqueSlug } from '../common/utils/slug.js';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.category.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: { where: { deletedAt: null } } } } },
    });
  }

  create(name: string) {
    return this.prisma.category.create({ data: { name, slug: uniqueSlug(name) } });
  }

  async update(id: string, name: string) {
    await this.findOrThrow(id);
    return this.prisma.category.update({ where: { id }, data: { name } });
  }

  async remove(id: string) {
    await this.findOrThrow(id);
    await this.prisma.$transaction([
      this.prisma.product.updateMany({ where: { categoryId: id }, data: { categoryId: null } }),
      this.prisma.category.update({ where: { id }, data: { deletedAt: new Date() } }),
    ]);
  }

  private async findOrThrow(id: string) {
    const category = await this.prisma.category.findFirst({ where: { id, deletedAt: null } });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }
}
