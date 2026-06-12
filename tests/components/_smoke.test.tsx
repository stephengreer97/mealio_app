// Smoke test for the jest-expo + @testing-library/react-native pipeline.
// If this stops compiling or running, the component-test infrastructure
// itself is broken — every real component test would silently break the
// same way.

import { render } from '@testing-library/react-native';
import { Text, View } from 'react-native';

function Hello({ who }: { who: string }) {
  return (
    <View>
      <Text>Hello, {who}!</Text>
    </View>
  );
}

test('renders text via @testing-library/react-native', () => {
  const { getByText } = render(<Hello who="Mealio" />);
  expect(getByText('Hello, Mealio!')).toBeTruthy();
});
