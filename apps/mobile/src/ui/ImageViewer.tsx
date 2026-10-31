import React, { useState } from 'react';
import {
  Image,
  Modal,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from './components';
import { space } from './theme';

export type ViewerImage = { uri: string; label: string };

/**
 * Full-screen viewer for verified local images. Photos read best on black in
 * both appearances, so the viewer keeps a fixed dark backdrop.
 */
export function ImageViewer({
  images,
  index,
  onClose,
}: {
  images: ViewerImage[];
  index: number;
  onClose: () => void;
}) {
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(index);
  const current = images[page] ?? images[0];
  return (
    <Modal
      visible
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.backdrop}>
        <View style={styles.top}>
          <Text
            accessibilityLiveRegion="polite"
            style={styles.caption}
            numberOfLines={2}
          >
            {current?.label}
            {images.length > 1 ? ` · ${page + 1} of ${images.length}` : ''}
          </Text>
          <View style={styles.done}>
            <Button label="Done" variant="secondary" onPress={onClose} />
          </View>
        </View>
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          contentOffset={{ x: index * width, y: 0 }}
          onMomentumScrollEnd={event =>
            setPage(
              Math.max(
                0,
                Math.min(
                  images.length - 1,
                  Math.round(event.nativeEvent.contentOffset.x / width),
                ),
              ),
            )
          }
        >
          {images.map(image => (
            <View key={image.uri} style={[styles.page, { width }]}>
              <Image
                source={{ uri: image.uri }}
                style={styles.image}
                resizeMode="contain"
                accessibilityLabel={image.label}
              />
            </View>
          ))}
        </ScrollView>
        {images.length > 1 ? (
          <Text style={styles.hint}>Swipe to see the others.</Text>
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000' },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  caption: { flex: 1, color: '#F2F2F2', fontSize: 16, lineHeight: 22 },
  done: { width: 110 },
  page: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  image: { width: '100%', height: '100%' },
  hint: {
    color: '#BDBDBD',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: space.sm,
  },
});
