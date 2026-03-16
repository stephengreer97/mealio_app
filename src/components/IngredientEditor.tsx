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

const UNITS = ['Qty', 'cups', 'fl oz', 'g', 'kg', 'L', 'lb', 'mg', 'ml', 'oz', 'tbsp', 'tsp'];

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
    measure: ing.unit === 'qty' ? String(ing.qty ?? 1) : (ing.measure ?? ''),
    unit: ing.unit === 'qty' ? 'Qty' : ing.unit,
    searchTerm: ing.searchTerm ?? null,
    qty: ing.qty ?? 1,
  };
}

function fromFormIng(form: IngredientForm): Ingredient {
  if (form.unit === 'Qty') {
    return {
      ingredientName: form.ingredientName.trim(),
      qty: parseInt(form.measure) || 1,
      unit: 'qty',
      measure: null,
      searchTerm: form.searchTerm ?? null,
      productQty: parseInt(form.measure) || 1,
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
      unit: 'Qty',
      searchTerm: null,
      qty: 1,
    };
    const updated = [...forms, newForm];
    emit(updated);
  }

  const pickerForm = unitPickerIndex !== null ? forms[unitPickerIndex] : null;

  return (
    <View>
      <Text style={styles.label}>Measurements</Text>
      {forms.map((form, index) => (
        <View key={index} style={styles.row}>
          <TextInput
            style={styles.nameInput}
            placeholder="Ingredient name"
            value={form.ingredientName}
            onChangeText={(v) => updateField(index, 'ingredientName', v)}
            placeholderTextColor={Colors.text3}
          />
          <TextInput
            style={styles.measureInput}
            placeholder={form.unit === 'Qty' ? '1' : 'amt'}
            value={form.measure}
            onChangeText={(v) => updateField(index, 'measure', v)}
            keyboardType={form.unit === 'Qty' ? 'numeric' : 'default'}
            placeholderTextColor={Colors.text3}
          />
          <TouchableOpacity
            style={styles.unitBtn}
            onPress={() => setUnitPickerIndex(index)}
          >
            <Text style={styles.unitBtnText} numberOfLines={1}>{form.unit}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => remove(index)} style={styles.deleteBtn}>
            <Ionicons name="trash-outline" size={18} color={Colors.error} />
          </TouchableOpacity>
        </View>
      ))}

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
