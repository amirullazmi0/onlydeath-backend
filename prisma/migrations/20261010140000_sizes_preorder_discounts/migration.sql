-- CreateEnum
CREATE TYPE "PreOrderMode" AS ENUM ('ANYTIME', 'PERIOD');

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "discount_pct" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "original_price" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "size_id" UUID,
ADD COLUMN     "size_label" VARCHAR(20);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "discount_total" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "po_end_at" TIMESTAMP(3),
ADD COLUMN     "po_mode" "PreOrderMode",
ADD COLUMN     "po_start_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "product_discounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "discount_pct" INTEGER NOT NULL,
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_sizes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "label" VARCHAR(20) NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_sizes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_discounts_product_id_idx" ON "product_discounts"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_sizes_product_id_label_key" ON "product_sizes"("product_id", "label");

-- AddForeignKey
ALTER TABLE "product_discounts" ADD CONSTRAINT "product_discounts_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_sizes" ADD CONSTRAINT "product_sizes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_size_id_fkey" FOREIGN KEY ("size_id") REFERENCES "product_sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Existing order items had no discount: original price = price
UPDATE "order_items" SET "original_price" = "price";
