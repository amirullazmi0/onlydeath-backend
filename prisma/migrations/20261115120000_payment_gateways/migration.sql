-- Payments now record which gateway (mayar | midtrans) created them and the id
-- that gateway's status API takes. Existing rows are Midtrans, keyed by order_no.
ALTER TABLE "payments" ADD COLUMN "gateway" VARCHAR(20) NOT NULL DEFAULT 'midtrans';
ALTER TABLE "payments" ALTER COLUMN "gateway" DROP DEFAULT;
ALTER TABLE "payments" ADD COLUMN "gateway_ref" VARCHAR(255);

UPDATE "payments" p SET "gateway_ref" = o."order_no" FROM "orders" o WHERE o."id" = p."order_id";

-- Snap now opens through redirect_url, so the token is no longer needed
ALTER TABLE "payments" DROP COLUMN "snap_token";

CREATE UNIQUE INDEX "payments_gateway_gateway_ref_key" ON "payments"("gateway", "gateway_ref");
