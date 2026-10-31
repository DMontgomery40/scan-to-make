import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Image, ScrollView, StyleSheet } from 'react-native';
import { ImageViewer } from '../src/ui/ImageViewer';

test('pages are as wide as the pager, so safe areas never shift the photos', async () => {
  const images = ['a', 'b', 'c'].map(n => ({
    uri: `file:///synthetic/${n}.png`,
    label: `View ${n}`,
  }));
  let tree!: Renderer.ReactTestRenderer;
  await act(async () => {
    tree = Renderer.create(
      <ImageViewer images={images} index={2} onClose={() => {}} />,
    );
  });
  const pager = () => tree.root.findByType(ScrollView);
  const scrollTo = jest.fn();
  pager().instance.scrollTo = scrollTo;
  // A folded iPhone Duo keeps a system bar beside the app.
  await act(async () => {
    pager().props.onLayout({ nativeEvent: { layout: { width: 386 } } });
  });
  const widths = tree.root
    .findAllByType(Image)
    .map(image => StyleSheet.flatten(image.parent!.props.style).width);
  expect(widths).toEqual([386, 386, 386]);
  // The native pager is moved, not just the mount-time offset prop.
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 772, animated: false });
  await act(async () => {
    pager().props.onMomentumScrollEnd({
      nativeEvent: { contentOffset: { x: 386 } },
    });
  });
  expect(pager().props.contentOffset).toEqual({ x: 386, y: 0 });
  await act(async () => tree.unmount());
});
