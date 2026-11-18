import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('verifies the correct password against its hash', async () => {
    const stored = await hashPassword('Student#2026');
    expect(stored).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    await expect(verifyPassword('Student#2026', stored)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('Student#2026');
    await expect(verifyPassword('student#2026', stored)).resolves.toBe(false);
  });

  it('uses a random salt, so the same password gives different hashes', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toEqual(b);
  });

  it('rejects a malformed stored hash', async () => {
    await expect(verifyPassword('x', 'plain-text')).resolves.toBe(false);
  });
});
