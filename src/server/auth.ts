import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Actor, Role } from '../shared/types';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, hash: string): boolean {
  const [salt, digest] = hash.split(':');
  if (!salt || !digest || digest.length !== 128) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');
export const demoActors: Actor[] = [
  ['analyst', 'Alex Rivera', 'analyst'], ['manager', 'Priya Sharma', 'manager'],
  ['warehouse', 'Kabir Rao', 'warehouse'], ['procurement', 'Ananya Iyer', 'procurement'],
  ['admin', 'Dev Admin', 'admin'], ['partner', 'Maya Chen', 'analyst'],
].map(([slug,name,role]) => ({ id: `${slug}-1`, name, email: `${slug}@disruptioniq.demo`, role: role as Role, orgId: slug === 'partner' ? 'partner' : 'focal' }));
