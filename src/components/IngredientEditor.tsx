import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius } from '../constants/colors';
import { Ingredient } from '../types';

interface IngredientEditorProps {
  ingredients: Ingredient[];
  onChange: (ingredients: Ingredient[]) => void;
}

export default function IngredientEditor({ ingredients, onChange }: IngredientEditorProps) {
  function updateName(index: number, value: string) {
    const updated = ingredients.map((ing, i) =>
      i === index ? { ...ing, productName: value } : ing
    );
    onChange(updated);
  }

  function updateQty(index: number, value: string) {
    const num = parseFloat(value);
    const updated = ingredients.map((ing, i) =>
      i === index ? { ...ing, quantity: isNaN(num) ? undefined : num } : ing
    );
    onChange(updated);
  }

  function remove(index: number) {
    onChange(ingredients.filter((_, i) => i !== index));
  }

  function addIngredient() {
    onChange([...ingredients, { productName: '' }]);
  }

  return (
    <View>
      <Text style={styles.label}>Ingredients</Text>
      {ingredients.map((ing, index) => (
        <View key={index} style={styles.row}>
          <View style={styles.qtyWrapper}>
            <TextInput
              style={styles.qtyInput}
              placeholder="Qty"
              value={ing.quantity !== undefined ? String(ing.quantity) : ''}
              onChangeText={(v) => updateQty(index, v)}
              keyboardType="numeric"
              placeholderTextColor={Colors.text3}
            />
          </View>
          <View style={styles.nameWrapper}>
            <TextInput
              style={styles.nameInput}
              placeholder="Ingredient name"
              value={ing.productName}
              onChangeText={(v) => updateName(index, v)}
              placeholderTextColor={Colors.text3}
            />
          </View>
          <TouchableOpacity onPress={() => remove(index)} style={styles.deleteBtn}>
            <Ionicons name="trash-outline" size={18} color={Colors.error} />
          </TouchableOpacity>
        </View>
      ))}

      <TouchableOpacity style={styles.addBtn} onPress={addIngredient}>
        <Ionicons name="add-circle-outline" size={20} color={Colors.brand} />
        <Text style={styles.addText}>Add ingredient</Text>
      </TouchableOpacity>
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
  qtyWrapper: {
    width: 56,
    borderRadius: Radius.input,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceRaised,
  },
  qtyInput: {
    padding: 8,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
    textAlign: 'center',
    letterSpacing: 0,
  },
  nameWrapper: {
    flex: 1,
    borderRadius: Radius.input,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceRaised,
  },
  nameInput: {
    padding: 8,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text1,
    letterSpacing: 0,
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
});
