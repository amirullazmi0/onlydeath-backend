import { randomBytes } from 'node:crypto';

export const slugify = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/(^-+)|(-+$)/g, '');

export const uniqueSlug = (value: string) => `${slugify(value)}-${randomBytes(3).toString('hex')}`;
