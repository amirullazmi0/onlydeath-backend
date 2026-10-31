interface DiscountLike {
  discountPct: number;
  isActive: boolean;
  startAt: Date | null;
  endAt: Date | null;
}

/** Highest active discount right now (kratify rule: discounts don't stack). */
export function activeDiscountPct(discounts: DiscountLike[], now = new Date()) {
  return discounts.reduce((max, d) => {
    const live =
      d.isActive && (!d.startAt || d.startAt <= now) && (!d.endAt || d.endAt >= now);
    return live ? Math.max(max, d.discountPct) : max;
  }, 0);
}

/** Discounted unit price in the same minor units (rupiah / cents), rounded. */
export const applyDiscount = (amount: number, pct: number) =>
  Math.round((amount * (100 - pct)) / 100);
