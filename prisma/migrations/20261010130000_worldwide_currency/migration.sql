-- Worldwide shipping (zones) + USD pricing for buyers outside Indonesia.

-- CreateEnum
CREATE TYPE "ShippingType" AS ENUM ('DOMESTIC', 'INTERNATIONAL');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('IDR', 'USD');

-- AlterTable: new order columns; NOT NULL ones get a temporary default so
-- existing rows can be backfilled below.
ALTER TABLE "orders" ADD COLUMN     "charge_shipping" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "charge_total" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "city" VARCHAR(255) NOT NULL DEFAULT '',
ADD COLUMN     "country_code" VARCHAR(2) NOT NULL DEFAULT 'ID',
ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'IDR',
ADD COLUMN     "exchange_rate" DECIMAL(14,4) NOT NULL DEFAULT 1,
ADD COLUMN     "shipping_type" "ShippingType" NOT NULL DEFAULT 'DOMESTIC',
ADD COLUMN     "state" VARCHAR(255),
ADD COLUMN     "tracking_url" TEXT,
ALTER COLUMN "area_id" DROP NOT NULL,
ALTER COLUMN "area_name" DROP NOT NULL,
ALTER COLUMN "postal_code" SET DATA TYPE VARCHAR(20),
ALTER COLUMN "courier_service" SET DATA TYPE VARCHAR(100);

-- Existing orders are all domestic IDR orders: the charged amount equals the total
UPDATE "orders"
SET "charge_total" = "total",
    "charge_shipping" = "shipping_cost",
    "city" = COALESCE("area_name", '');

ALTER TABLE "orders" ALTER COLUMN "charge_shipping" DROP DEFAULT,
ALTER COLUMN "charge_total" DROP DEFAULT,
ALTER COLUMN "city" DROP DEFAULT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "price_usd_cents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "shipping_zones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "countries" VARCHAR(2)[],
    "base_rate_cents" INTEGER NOT NULL,
    "per_kg_rate_cents" INTEGER NOT NULL,
    "eta_text" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "shipping_zones_pkey" PRIMARY KEY ("id")
);
