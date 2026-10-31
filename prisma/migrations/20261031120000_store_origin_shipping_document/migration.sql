-- AlterTable
ALTER TABLE "orders" ADD COLUMN "shipping_document_url" TEXT;

-- CreateTable
CREATE TABLE "store_origin" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "contact_name" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(30) NOT NULL,
    "address" TEXT NOT NULL,
    "postal_code" VARCHAR(10) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_origin_pkey" PRIMARY KEY ("id")
);
