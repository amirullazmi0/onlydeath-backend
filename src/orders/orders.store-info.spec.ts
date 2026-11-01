import { describe, expect, it, vi } from 'vitest';
import { templates } from '../mail/mail.templates.js';
import { OrdersService } from './orders.service.js';

const setup = (getOrigin: () => Promise<unknown>) =>
  new OrdersService(
    {} as never,
    { getOrigin } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { get: vi.fn((key: string) => (key === 'STORE_ADDRESS' ? 'Env address' : undefined)) } as never,
  );

describe('storeInfo', () => {
  it('prints the sender address saved in admin settings', async () => {
    const service = setup(async () => ({ address: 'Jl. Babakan', postalCode: '40163' }));

    await expect(service.storeInfo()).resolves.toMatchObject({ address: 'Jl. Babakan, 40163' });
  });

  it('falls back to the env address when none is saved', async () => {
    const service = setup(async () => null);

    await expect(service.storeInfo()).resolves.toMatchObject({ address: 'Env address' });
  });

  it('still returns store details when the lookup fails', async () => {
    const service = setup(async () => {
      throw new Error('db down');
    });

    await expect(service.storeInfo()).resolves.toMatchObject({ address: 'Env address' });
  });
});

describe('email layout', () => {
  it('shows the logo image in the header instead of the store name', () => {
    const html = templates['order-status']({
      appName: 'OnlyDeath',
      logoUrl: 'http://fe/brand/logo-black-email.png',
    });

    expect(html).toContain('<img src="http://fe/brand/logo-black-email.png" alt="OnlyDeath"');
  });
});
