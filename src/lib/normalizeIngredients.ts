// Ingredient normalization for ingredient lists fetched from the API.
//
// DB rows can carry varied ingredient shapes depending on which writer last
// touched them (web vs mobile vs creator portal vs preset import). This
// function smooths over those differences so callers get a single canonical
// Ingredient[] regardless of source. The normalizer is also used by the
// preset-meal save flow and the discover-page ingredient editor.
//
// Extracted from api.ts so unit tests can exercise it without dragging the
// expo-secure-store import chain through node-jest.

import type { Ingredient } from '../types';

export function normalizeIngredients(raw: any): Ingredient[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === 'string') {
      return { ingredientName: item, qty: 1, productQty: 1, unit: 'qty', measure: null };
    }
    if (item && typeof item === 'object') {
      const qty = item.qty ?? item.quantity ?? 1;
      return {
        ingredientName: item.ingredientName ?? item.productName ?? item.product_name ?? String(item.name ?? item) ?? '',
        searchTerm: item.searchTerm ?? item.search_term ?? null,
        qty,
        productQty: item.productQty ?? qty,
        unit: item.unit ?? 'qty',
        measure: item.measure ?? null,
        dropdown: item.dropdown ?? null,
      };
    }
    return { ingredientName: String(item), qty: 1, productQty: 1, unit: 'qty', measure: null };
  }).filter((i) => i.ingredientName);
}
