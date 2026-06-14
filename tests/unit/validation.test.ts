import { isValidEmail } from '../../src/lib/validation';

// Covers the email-regex branch the auth screens share. The Maestro signup
// flow can't reach this branch (keyboard blocks the submit button), so this
// is its coverage.
describe('isValidEmail', () => {
  it.each([
    'a@b.co',
    'jane.smith@example.com',
    'user+tag@sub.domain.io',
  ])('accepts %s', (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['no @', 'not-an-email'],
    ['no domain dot', 'user@localhost'],
    ['no local part', '@b.co'],
    ['just text', 'hello world'],
    ['trailing space only', '   '],
  ])('rejects %s', (_label, email) => {
    expect(isValidEmail(email)).toBe(false);
  });
});
