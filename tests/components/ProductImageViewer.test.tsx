// MEAL-64: the full-screen product photo and its ways out.
//
// The tap that OPENS it comes from a PanResponder (see draggablePreviewTap.test)
// and cannot be fired here — a captured gesture has no onPress to press. What is
// testable is the viewer itself: that it shows the photo, that each dismissal
// route calls onClose, and that it stays out of the way with no photo to show.

import { fireEvent, render } from '@testing-library/react-native';

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return {
    Image: (props: any) => RealReact.createElement(RealView, props),
  };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return {
    Ionicons: (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

import ProductImageViewer from '../../src/components/ProductImageViewer';

const URI = 'https://example.test/product.jpg';

describe('ProductImageViewer', () => {
  it('shows the product photo when visible', () => {
    const { getByTestId } = render(
      <ProductImageViewer uri={URI} visible onClose={() => {}} />,
    );
    expect(getByTestId('product-image-viewer-image').props.source).toEqual({ uri: URI });
  });

  it('renders nothing when not visible', () => {
    const { queryByTestId } = render(
      <ProductImageViewer uri={URI} visible={false} onClose={() => {}} />,
    );
    expect(queryByTestId('product-image-viewer-image')).toBeNull();
  });

  it('renders nothing when the product has no photo', () => {
    // Products without images keep their current no-thumbnail behaviour: there
    // is nothing to enlarge, so the viewer must never open on an empty frame.
    const { queryByTestId } = render(
      <ProductImageViewer uri={null} visible onClose={() => {}} />,
    );
    expect(queryByTestId('product-image-viewer-image')).toBeNull();
  });

  it('closes on the ✕', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(<ProductImageViewer uri={URI} visible onClose={onClose} />);
    fireEvent.press(getByTestId('product-image-viewer-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop tap', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(<ProductImageViewer uri={URI} visible onClose={onClose} />);
    fireEvent.press(getByTestId('product-image-viewer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on the Android hardware back button', () => {
    const onClose = jest.fn();
    const { UNSAFE_getByType } = render(
      <ProductImageViewer uri={URI} visible onClose={onClose} />,
    );
    const { Modal } = jest.requireActual('react-native');
    UNSAFE_getByType(Modal).props.onRequestClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
