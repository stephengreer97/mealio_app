import { SERVES_ERROR, SERVES_PATTERN, servesChangeError } from '../../src/constants/serves';

/**
 * The `serves` rule as the creator portal applies it.
 *
 * The portal's `serves` field is a plain text input with no check of any kind,
 * so "12 pancakes" reached `POST /api/creator/meals` and came back as the
 * server's sentence in an `Alert` — after Save Meal had been pressed, on a form
 * that never said there was a rule.
 *
 * The grandfathering half matters as much as the rule: the form posts `serves`
 * on every save whether or not the creator opened it, and meals published before
 * the rule existed carry values it refuses. A client stricter than the route it
 * posts to turns the 400 it was meant to pre-empt into a request never sent.
 */

describe('servesChangeError — the rule', () => {
  it('takes a head count and a range, which is what the field is for', () => {
    expect(servesChangeError('4', null)).toBeNull();
    expect(servesChangeError('2-4', null)).toBeNull();
  });

  it('refuses a yield, in the server\'s own words', () => {
    expect(servesChangeError('12 pancakes', null)).toBe(SERVES_ERROR);
    expect(servesChangeError('2 1/2 cups', null)).toBe(SERVES_ERROR);
    expect(servesChangeError('1 loaf', null)).toBe(SERVES_ERROR);
  });

  it('takes an empty field — the whole thing is optional', () => {
    expect(servesChangeError('', null)).toBeNull();
    expect(servesChangeError('   ', null)).toBeNull();
  });

  it('trims before judging, so a stray space is not a refusal', () => {
    expect(servesChangeError('  4 ', null)).toBeNull();
  });

  it('matches the pattern the server publishes under', () => {
    expect(SERVES_PATTERN.test('4')).toBe(true);
    expect(SERVES_PATTERN.test('2-4')).toBe(true);
    expect(SERVES_PATTERN.test('2 1/2 cups')).toBe(false);
  });
});

describe('servesChangeError — grandfathering', () => {
  it('lets an untouched legacy value through, so the meal stays editable', () => {
    // The creator opened this meal to fix a typo in the name. The form posts
    // `serves` regardless; refusing here loses the edit and blames a field they
    // never opened.
    expect(servesChangeError('2 1/2 cups', '2 1/2 cups')).toBeNull();
  });

  it('ignores whitespace when deciding whether it changed', () => {
    expect(servesChangeError(' 2 1/2 cups ', '2 1/2 cups')).toBeNull();
  });

  it('refuses a yield the save is actually setting', () => {
    expect(servesChangeError('12 pancakes', '4')).toBe(SERVES_ERROR);
  });

  it('lets a legacy value be replaced with a head count', () => {
    expect(servesChangeError('4', '2 1/2 cups')).toBeNull();
  });

  it('lets a legacy value be cleared — emptying it is always allowed', () => {
    expect(servesChangeError('', '2 1/2 cups')).toBeNull();
  });

  it('reads a numeric stored value as the text the column holds', () => {
    // An older row can hold the number 4 rather than the string "4"; that is
    // not a change the creator made by opening the form.
    expect(servesChangeError('4', 4)).toBeNull();
  });
});
