import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Modal,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Radius } from '../constants/colors';
import { Ingredient } from '../types';

const UNITS = ['qty', 'cups', 'fl oz', 'g', 'kg', 'L', 'lb', 'mg', 'ml', 'oz', 'tbsp', 'tsp',
  // Units a cook writes that convert to nothing, and never needed to. Display
  // only: the store search uses searchTerm/ingredientName, the number of
  // packages comes from productQty, and consolidation keys on searchTerm. The
  // only branch that inspects a unit is `unit === 'qty'`, which picks between
  // two display formats.
  //
  // Carrying the word costs nothing and stops "3 cloves garlic" reading as
  // "garlic, 3", which told the cart to buy three heads of garlic. The server
  // canonicalises to exactly this set, so a row arriving with one of them used
  // to show its unit correctly and then have no option to select — opening the
  // picker was a one-way trip out of it.
  //
  // Kept in step with the same list in mealio_central.
  'cloves', 'cans', 'bunches', 'sprigs', 'pinches', 'handfuls', 'grinds', 'slices'];

/**
 * Longest preparation this box accepts, in step with `MAX_PREP_CHARS` in
 * mealio_central (`lib/import/ingredients.ts`).
 *
 * Duplicated rather than fetched, the same way the unit list above is. It has to
 * be here because of what the SERVER does over the cap: `canonicalPrep` DROPS an
 * over-cap preparation rather than truncating it, and a draft edited here goes
 * back through `creatorDrafts.edit` → `editableDraft` → that canonicaliser. So
 * without this a creator could paste a method step, get a success, and watch the
 * text vanish (MEAL-165 found exactly that on the website).
 */
export const MAX_PREP_CHARS = 120;

interface IngredientForm {
  ingredientName: string;
  measure: string;
  unit: string;
  searchTerm: string | null;
  qty: number;
  /**
   * Preparation — "finely diced" (MEAL-102), editable as of MEAL-170.
   *
   * It was read-only here while how a creator types one was still open. MEAL-165
   * settled that on the website — its own box, on the review card and the
   * publish form — and this is the same screen on a phone, so it gets the same
   * box. Until now a creator looking at their own draft in the app could SEE a
   * preparation the model invented and could only delete the whole ingredient
   * row to be rid of it.
   */
  prep?: string;
  /**
   * The row this form was built from, carried so `fromFormIng` can put back
   * everything the form does not own (MEAL-164).
   *
   * This exists because of what `emit` does: every keystroke on any row runs the
   * WHOLE list back through `fromFormIng`. That used to build each `Ingredient`
   * from a literal, so any field the form did not hold was not merely
   * un-editable — it was DELETED, on every row, by correcting a typo in one
   * ingredient's name. Three fields were being lost that way:
   *
   *   • `purchaseWeight` — the weight a shopper CHOSE for a sold-by-weight item
   *     (H-E-B Deli, Fish Market, bulk), remembered so the next run auto-adds
   *     that amount instead of re-prompting. Losing it means the next run adds a
   *     different amount than the user picked, which is the over/under-add
   *     failure the cart's governing principles exist to prevent — arriving
   *     through an edit screen rather than through the cart.
   *   • `weightStep` — the increment that weight is chosen in.
   *   • `dropdown` — the product preference the shopper selected.
   *
   * The write reaches storage through three callers (`MealDetailSheet.handleSave`,
   * `CreatorPortalScreen`, and `creatorDrafts.edit` from the draft review queue).
   *
   * Carrying the source row rather than adding a fourth field to the literal is
   * the point: the defect is a form that silently owns MORE than it displays, so
   * the fix has to invert the default. Fields are now preserved unless the form
   * explicitly owns them, and the list of what it owns is right there in
   * `fromFormIng`.
   *
   * Absent on a row the editor itself created, which has no source to preserve.
   */
  source?: Ingredient;
}

function toFormIng(ing: Ingredient): IngredientForm {
  return {
    ingredientName: ing.ingredientName,
    // Blank rather than "1" for a plain count. Every line the source never
    // quantified — "salt to taste", "many grinds of black pepper" — arrives as
    // a countable 1, and typing that into the box states an amount we read
    // rather than one we defaulted to. `fromFormIng` parses an empty measure
    // straight back to 1, so nothing changes on save.
    // `measure` first for countables too, now that it is what the card reads.
    // The `qty` fallback is for rows written before that; without it a creator
    // opening an older meal sees an empty box and saves the number away.
    measure: ing.unit === 'qty'
      ? ((ing.measure ?? '').trim() || ((ing.qty ?? 1) > 1 ? String(ing.qty) : ''))
      : (ing.measure ?? ''),
    // The picker's countable option is spelled the way the row stores it, so
    // there is no longer a translation here.
    unit: ing.unit ?? 'qty',
    searchTerm: ing.searchTerm ?? null,
    qty: ing.qty ?? 1,
    // Spread, so a row with no preparation still has no `prep` key when
    // `fromFormIng` puts it back together — see the field's note above.
    ...(ing.prep ? { prep: ing.prep } : {}),
    source: ing,
  };
}

/**
 * Everything this form owns. Anything NOT listed here is preserved from the row
 * the form was built from — see `IngredientForm.source`.
 *
 * Typed as the exact key set rather than `Partial<Ingredient>` so that dropping
 * one is a compile error. `Partial` would let a field silently fall out of both
 * returns and be picked up from a stale `source` instead, which is a quieter
 * version of the bug this file is fixing.
 *
 * `Required` is doing real work here and is not decoration. `searchTerm` and
 * `measure` are OPTIONAL on `Ingredient`, so a bare `Pick` accepts a return that
 * omits them — a cold review measured exactly that, dropping each from the type
 * and from both returns with `tsc` still exiting 0. `searchTerm` is the one that
 * matters: unowned, it comes from the stale `source`, so `updateField`'s
 * "clear the chosen product when the name changes" stops persisting and a
 * cleared product resurrects. Both are `T | null` already, so requiring them
 * costs nothing at runtime.
 */
type OwnedFields = Required<Pick<Ingredient, 'ingredientName' | 'qty' | 'unit' | 'productQty' | 'measure' | 'searchTerm'>>;

function ownedFields(form: IngredientForm): OwnedFields {
  if (form.unit === 'qty') {
    // Radix 10 so leading-zero input isn't parsed as octal. A qty of 0 isn't a
    // valid cart quantity, so an empty/NaN/0 measure defaults to 1.
    const parsed = parseInt(form.measure, 10);
    const qty = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    return {
      ingredientName: form.ingredientName.trim(),
      qty,
      unit: 'qty',
      measure: null,
      searchTerm: form.searchTerm ?? null,
      productQty: qty,
    };
  }
  return {
    ingredientName: form.ingredientName.trim(),
    qty: 1,
    unit: form.unit,
    measure: form.measure.trim() || null,
    searchTerm: form.searchTerm ?? null,
    productQty: 1,
  };
}

/**
 * The fields that belong to the CHOSEN PRODUCT rather than to the recipe line,
 * and so cannot outlive it.
 *
 * `saveChosenIngredient` writes them in the same breath as `searchTerm`, when a
 * shopper picks a product. Editing an ingredient's name already clears
 * `searchTerm` — the row goes back to being unchosen — and a remembered weight
 * or preference left behind would then be applied to whatever product is chosen
 * NEXT. Preserving them there would swap one over/under-add for another.
 *
 * `storeProducts` (MEAL-19) is the sharpest case, which is why it is here rather
 * than treated as recipe data: it is the store's own identifier for the product,
 * so a stale one does not merely bias a search — it resolves, and the old
 * product goes in the cart without anybody choosing it.
 */
const PRODUCT_BOUND_FIELDS = ['dropdown', 'purchaseWeight', 'weightStep', 'storeProducts'] as const;

function fromFormIng(form: IngredientForm): Ingredient {
  // No cast: `ownedFields` supplies every required key of `Ingredient`, so this
  // stops compiling the moment one is dropped from it.
  const next: Ingredient = { ...form.source, ...ownedFields(form) };

  // `prep` is owned but optional, and the spread above may have carried an old
  // one in. Absent has to stay absent (MEAL-102), so clearing it deletes the key
  // rather than writing null.
  // Trimmed, and absent rather than empty: whitespace-only is no preparation,
  // which is the one rule this box shares with the server.
  //
  // NOT the same rule as `canonicalPrep`, which also collapses internal
  // whitespace and strips leading/trailing `,;:-` — so a value this box accepts
  // can still be rewritten server-side, and a lone "," passes `trim()` here and
  // canonicalises to nothing there. Matching that normaliser exactly would mean
  // a second copy of it drifting in a second repo; the honest scope is that the
  // box refuses only what is obviously empty.
  const prep = form.prep?.trim();
  if (prep) next.prep = prep;
  else delete next.prep;

  if (!next.searchTerm) {
    for (const field of PRODUCT_BOUND_FIELDS) delete next[field];
  }

  return next;
}

interface IngredientEditorProps {
  ingredients: Ingredient[];
  onChange: (ingredients: Ingredient[]) => void;
}

function getDuplicateIndices(forms: IngredientForm[]): Set<number> {
  const seen = new Map<string, number>();
  const dups = new Set<number>();
  forms.forEach((f, i) => {
    const key = f.ingredientName.trim().toLowerCase();
    if (!key) return;
    if (seen.has(key)) {
      dups.add(seen.get(key)!);
      dups.add(i);
    } else {
      seen.set(key, i);
    }
  });
  return dups;
}

export default function IngredientEditor({ ingredients, onChange }: IngredientEditorProps) {
  const insets = useSafeAreaInsets();
  const [forms, setForms] = useState<IngredientForm[]>(() => ingredients.map(toFormIng));
  const [unitPickerIndex, setUnitPickerIndex] = useState<number | null>(null);
  /**
   * The exact array this editor last handed to `onChange`.
   *
   * Seeded with the incoming list rather than `null` so the effect below is a
   * no-op on mount — `forms` was just built from this same array, and starting
   * at `null` made every mount rebuild all of them from a state already equal to
   * the seed.
   */
  const lastEmittedRef = useRef<Ingredient[]>(ingredients);

  /**
   * Re-read the list when something OTHER than this editor changes it.
   *
   * `forms` is seeded once, and it is not the only writer of the array it edits.
   * `MealDetailSheet` renders this editor and its "Products" section against the
   * same `ingredients` state at the same time, and that section clears
   * `searchTerm` and steps `purchaseWeight`. Without this, the next keystroke
   * anywhere in the editor rebuilt every row from the seed and silently reverted
   * those edits.
   *
   * That was already true for `searchTerm`, which the form held a stale copy of.
   * Carrying `source` would have widened it to `purchaseWeight` — and reverting
   * a CLEARED product to a remembered weight is worse than the bug this ticket
   * fixes, because `WebViewCartSheet` auto-adds a row that has a `searchTerm`
   * without prompting. So the seed has to stop being a seed.
   *
   * Identity, not deep equality, is what separates the two cases: `emit` hands
   * `onChange` an array and the parent stores that same array, so our own echo
   * arrives reference-equal. Any other writer builds a new one.
   *
   * THAT IS A CONTRACT ON THE CONSUMER, and it is invisible from their side, so
   * it is written down here. All four store the array unchanged today
   * (`MealDetailSheet`, `MyMealsScreen`, `CreatorPortalScreen` pass `setState`
   * directly; `CreatorReviewQueueScreen` wraps it in a new object but keeps the
   * same array). A parent that stored a COPY — a `[...ings]`, or the
   * `normalizeIngredients` pass CLAUDE.md tells people to put on ingredient
   * data — would never match, so every keystroke would resync and a shopper
   * could not type a multi-digit amount: the first digit renders as an empty box
   * and vanishes under the cursor. Measured by a cold review with a copying
   * parent. If a consumer ever needs to transform the array, this guard has to
   * become value-equality first.
   */
  useEffect(() => {
    if (lastEmittedRef.current === ingredients) return;
    setForms(ingredients.map(toFormIng));
  }, [ingredients]);

  function emit(updated: IngredientForm[]) {
    setForms(updated);
    const next = updated.map(fromFormIng);
    lastEmittedRef.current = next;
    onChange(next);
  }

  function updateField(index: number, field: keyof IngredientForm, value: string | number | null) {
    const updated = forms.map((f, i) => {
      if (i !== index) return f;
      const next = { ...f, [field]: value };
      // ONLY the name clears the chosen product. Renaming a row means it is a
      // different ingredient, so the product picked for the old one no longer
      // applies — and `fromFormIng` then drops `dropdown`, `purchaseWeight` and
      // `weightStep` with it.
      //
      // Adding `prep` to this condition would therefore delete a shopper's
      // remembered deli weight because they typed "thin sliced", which is the
      // over/under-add MEAL-164 exists to prevent, arriving through the box
      // MEAL-170 added. A preparation is not a product choice: "finely diced"
      // says nothing about which onion was picked.
      if (field === 'ingredientName') {
        next.searchTerm = null;
      }
      return next;
    });
    emit(updated);
  }

  function selectUnit(index: number, unit: string) {
    const updated = forms.map((f, i) => i === index ? { ...f, unit } : f);
    emit(updated);
    setUnitPickerIndex(null);
  }

  function remove(index: number) {
    const updated = forms.filter((_, i) => i !== index);
    emit(updated);
  }

  function addMeasurement() {
    const newForm: IngredientForm = {
      ingredientName: '',
      measure: '1',
      unit: 'qty',
      searchTerm: null,
      qty: 1,
    };
    const updated = [...forms, newForm];
    emit(updated);
  }

  const pickerForm = unitPickerIndex !== null ? forms[unitPickerIndex] : null;
  const duplicateIndices = getDuplicateIndices(forms);

  return (
    <View>
      <Text style={styles.label}>Measurements</Text>
      {forms.map((form, index) => {
        const isDup = duplicateIndices.has(index);
        return (
        <View key={index}>
          <View style={styles.row}>
          <TextInput
            style={[styles.nameInput, isDup && styles.nameInputError]}
            placeholder="Ingredient name"
            value={form.ingredientName}
            onChangeText={(v) => updateField(index, 'ingredientName', v)}
            placeholderTextColor={Colors.text3}
          />
          <TextInput
            style={styles.measureInput}
            placeholder={form.unit === 'qty' ? '1' : 'amt'}
            value={form.measure}
            onChangeText={(v) => updateField(index, 'measure', v)}
            keyboardType={form.unit === 'qty' ? 'numeric' : 'default'}
            placeholderTextColor={Colors.text3}
          />
          <TouchableOpacity
            style={styles.unitBtn}
            onPress={() => setUnitPickerIndex(index)}
          >
            <Text style={styles.unitBtnText} numberOfLines={1}>{form.unit}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => remove(index)} style={styles.deleteBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="trash-outline" size={18} color={Colors.error} />
          </TouchableOpacity>
          </View>
          {/* The name field's error, kept directly under the row it describes —
              putting it below the preparation box separates it from the input it
              is about by an unrelated control. */}
          {isDup && (
            <Text style={styles.dupError}>Duplicate ingredient name</Text>
          )}
          {/* What the line asks be DONE to the product (MEAL-170).
              Its own row rather than a fourth control on the one above, because
              a preparation is a phrase and the name/amount/unit row is already
              three controls wide on a phone. No label: the placeholder says what
              belongs here, and a labelled empty box on every ingredient would
              read as something missing — prep is null far more often than not. */}
          <TextInput
            style={styles.prepInput}
            placeholder="finely diced"
            placeholderTextColor={Colors.text3}
            value={form.prep ?? ''}
            onChangeText={(v) => updateField(index, 'prep', v)}
            maxLength={MAX_PREP_CHARS}
            accessibilityLabel={`Ingredient ${index + 1} preparation`}
            testID={`ingredient-prep-${index}`}
          />
        </View>
        );
      })}

      <TouchableOpacity style={styles.addBtn} onPress={addMeasurement}>
        <Ionicons name="add-circle-outline" size={20} color={Colors.brand} />
        <Text style={styles.addText}>Add measurement</Text>
      </TouchableOpacity>

      {/* Unit picker modal */}
      <Modal
        visible={unitPickerIndex !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setUnitPickerIndex(null)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setUnitPickerIndex(null)} />
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Select Unit</Text>
            <ScrollView keyboardShouldPersistTaps="handled">
              {UNITS.map((unit) => (
                <TouchableOpacity
                  key={unit}
                  style={styles.unitOption}
                  onPress={() => unitPickerIndex !== null && selectUnit(unitPickerIndex, unit)}
                >
                  <Text style={[
                    styles.unitOptionText,
                    pickerForm?.unit === unit && styles.unitOptionTextActive,
                  ]}>
                    {unit}
                  </Text>
                  {pickerForm?.unit === unit && (
                    <Ionicons name="checkmark" size={18} color={Colors.brand} />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text2,
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 6,
  },
  nameInput: {
    flex: 1,
    borderRadius: Radius.input,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceRaised,
    padding: 8,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
    letterSpacing: 0,
  },
  measureInput: {
    width: 64,
    borderRadius: Radius.input,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceRaised,
    padding: 8,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
    textAlign: 'center',
    letterSpacing: 0,
  },
  unitBtn: {
    width: 72,
    borderRadius: Radius.input,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceRaised,
    paddingVertical: 8,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unitBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    color: Colors.text1,
  },
  deleteBtn: { padding: 4 },
  nameInputError: {
    borderColor: Colors.error,
  },
  prepInput: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.input,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginTop: -2,
    marginBottom: 6,
  },
  dupError: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: Colors.error,
    marginTop: -4,
    marginBottom: 4,
    marginLeft: 2,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 6,
  },
  addText: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    color: Colors.brand,
  },
  // Modal
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalSheet: {
    backgroundColor: Colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '60%',
    paddingTop: 12,
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text1,
    textAlign: 'center',
    marginBottom: 8,
    paddingHorizontal: 16,
  },
  unitOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  unitOptionText: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
  },
  unitOptionTextActive: {
    fontFamily: 'Inter_600SemiBold',
    color: Colors.brand,
  },
});
