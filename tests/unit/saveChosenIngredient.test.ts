import {
  mergeChosenProduct,
  createMealSaveQueue,
} from '../../src/lib/saveChosenIngredient';

describe('mergeChosenProduct', () => {
  const base = [
    { ingredientName: 'Yogurt', searchTerm: null, productQty: 1 },
    { ingredientName: 'Saffron', searchTerm: null, productQty: 1 },
  ];

  it('sets searchTerm on the matching ingredient and leaves others untouched', () => {
    const out = mergeChosenProduct(base, 'Yogurt', 'Fage Total 0% Greek Yogurt');
    expect(out[0].searchTerm).toBe('Fage Total 0% Greek Yogurt');
    expect(out[1]).toBe(base[1]); // unchanged reference
  });

  it('does not mutate the input array or rows', () => {
    const out = mergeChosenProduct(base, 'Yogurt', 'X');
    expect(base[0].searchTerm).toBeNull();
    expect(out).not.toBe(base);
  });

  it('applies qty when provided', () => {
    const out = mergeChosenProduct(base, 'Saffron', 'H-E-B Saffron', { qty: 3 });
    expect(out[1].productQty).toBe(3);
  });

  it('matches by existing searchTerm, not just display name', () => {
    const rows = [{ ingredientName: 'milk', searchTerm: 'Whole Milk', productQty: 1 }];
    const out = mergeChosenProduct(rows, 'Whole Milk', 'MALK Oat Milk');
    expect(out[0].searchTerm).toBe('MALK Oat Milk');
  });

  it('tolerates product_name / productName / name key variants', () => {
    const rows = [
      { product_name: 'Eggs', searchTerm: null },
      { name: 'Butter', searchTerm: null },
    ];
    expect(mergeChosenProduct(rows, 'Eggs', 'H-E-B Eggs')[0].searchTerm).toBe('H-E-B Eggs');
    expect(mergeChosenProduct(rows, 'Butter', 'Kerrygold')[1].searchTerm).toBe('Kerrygold');
  });

  it('sets the dropdown when given, clears a stale one when not', () => {
    const rows = [{ ingredientName: 'Avocado', searchTerm: null, dropdown: { type: 'preference', selectedText: 'old', selectedValue: 'o' } }];
    const withPref = mergeChosenProduct(rows, 'Avocado', 'H-E-B Avocado', {
      dropdown: { type: 'preference', selectedText: 'Ready Now', selectedValue: 'rn' },
    });
    expect(withPref[0].dropdown.selectedText).toBe('Ready Now');
    const cleared = mergeChosenProduct(rows, 'Avocado', 'H-E-B Avocado');
    expect(cleared[0].dropdown).toBeNull();
  });
});

describe('createMealSaveQueue — concurrent same-meal saves do not clobber', () => {
  // Reproduces the original bug: every choice PATCHes the meal's WHOLE ingredient
  // array, rebuilt from a snapshot. Fired concurrently with a slow round-trip,
  // later writes overwrote earlier ones. The queue must serialize them so every
  // chosen product survives.

  // A fake server holding one meal with 3 unchosen ingredients.
  function makeFakeServer() {
    const store: Record<string, any> = {
      m1: {
        id: 'm1',
        ingredients: [
          { ingredientName: 'Yogurt', searchTerm: null },
          { ingredientName: 'Saffron', searchTerm: null },
          { ingredientName: 'Ghee', searchTerm: null },
        ],
      },
    };
    // Mirrors the component's allMealsRef: the source the save reads from.
    const ref = { current: [store.m1] };
    async function update(mealId: string, data: { ingredients: any[] }) {
      // Simulate network latency so concurrent saves would overlap without a queue.
      await new Promise((r) => setTimeout(r, 5));
      store[mealId] = { ...store[mealId], ingredients: data.ingredients };
      return store[mealId];
    }
    return { store, ref, update };
  }

  it('persists all three choices made back-to-back on the same meal', async () => {
    const { store, ref, update } = makeFakeServer();
    const enqueue = createMealSaveQueue();

    const choose = (ingredientName: string, productName: string) =>
      enqueue('m1', async () => {
        const meal = ref.current.find((m) => m.id === 'm1')!;
        const updatedIngredients = mergeChosenProduct(meal.ingredients, ingredientName, productName);
        const updated = await update('m1', { ingredients: updatedIngredients });
        ref.current = ref.current.map((m) => (m.id === updated.id ? updated : m));
      });

    // Fire all three without awaiting between them (the real UI advances
    // immediately after each tap).
    await Promise.all([
      choose('Yogurt', 'Fage Total 0%'),
      choose('Saffron', 'H-E-B Spanish Saffron'),
      choose('Ghee', 'Laxmi Pure Ghee'),
    ]);

    const saved = store.m1.ingredients;
    expect(saved.find((i: any) => i.ingredientName === 'Yogurt').searchTerm).toBe('Fage Total 0%');
    expect(saved.find((i: any) => i.ingredientName === 'Saffron').searchTerm).toBe('H-E-B Spanish Saffron');
    expect(saved.find((i: any) => i.ingredientName === 'Ghee').searchTerm).toBe('Laxmi Pure Ghee');
  });

  it('a failed save does not stall later saves on the same meal', async () => {
    const calls: string[] = [];
    const enqueue = createMealSaveQueue();
    const a = enqueue('m1', async () => { calls.push('a'); throw new Error('boom'); });
    const b = enqueue('m1', async () => { calls.push('b'); });
    await Promise.allSettled([a, b]);
    expect(calls).toEqual(['a', 'b']);
  });

  it('runs different meals in parallel (not serialized across meals)', async () => {
    const order: string[] = [];
    const enqueue = createMealSaveQueue();
    const slow = enqueue('m1', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('m1');
    });
    const fast = enqueue('m2', async () => {
      order.push('m2');
    });
    await Promise.all([slow, fast]);
    // m2 finished before slow m1 → they did not serialize against each other.
    expect(order).toEqual(['m2', 'm1']);
  });
});
