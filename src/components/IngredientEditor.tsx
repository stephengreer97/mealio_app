import React, { useState } from 'react';
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

interface IngredientForm {
  ingredientName: string;
  measure: string;
  unit: string;
  searchTerm: string | null;
  qty: number;
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
  };
}

function fromFormIng(form: IngredientForm): Ingredient {
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

  function emit(updated: IngredientForm[]) {
    setForms(updated);
    onChange(updated.map(fromFormIng));
  }

  function updateField(index: number, field: keyof IngredientForm, value: string | number | null) {
    const updated = forms.map((f, i) => {
      if (i !== index) return f;
      const next = { ...f, [field]: value };
      // When ingredientName changes, clear searchTerm
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
          {isDup && (
            <Text style={styles.dupError}>Duplicate ingredient name</Text>
          )}
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
