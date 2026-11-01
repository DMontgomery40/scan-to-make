import React, { useCallback, useEffect, useState } from 'react';
import {
  AppState,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';
import { ObjectsError, type ObjectsClient } from '../objects/client';
import { describeObject } from '../objects/model';
import type { StmObject } from '../objects/types';

const POLL_MS = 3000;
const TONE = {
  pending: colors.pending,
  pass: colors.pass,
  fail: colors.fail,
  accent: colors.accent,
  neutral: colors.muted,
};

function Thumbnail({
  client,
  object,
}: {
  client: ObjectsClient;
  object: StmObject;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const render = object.current?.renders[0];
  useEffect(() => {
    let live = true;
    setUri(null);
    if (render)
      client.renderUri(object, render).then(
        found => live && setUri(found),
        () => {},
      );
    return () => {
      live = false;
    };
    // A new render comes with a new object version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object.id, object.updatedAtMs, render]);
  return (
    <View style={styles.thumb}>
      {uri ? (
        <Image
          source={{ uri }}
          resizeMode="contain"
          style={styles.thumbImage}
        />
      ) : null}
    </View>
  );
}

/** Everything sent to the Mac, newest first. */
export function ObjectsScreen({
  client,
  selected,
  refreshKey = 0,
  onNew,
  onOpen,
  onPair,
}: {
  client: ObjectsClient;
  /** Highlighted in the two-pane layout. */
  selected?: string | null;
  /** Bumped by the app when something changed elsewhere. */
  refreshKey?: number;
  onNew: () => void;
  onOpen: (id: string) => void;
  onPair: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [objects, setObjects] = useState<StmObject[] | null>(null);
  const [error, setError] = useState<ObjectsError | null>(null);
  const load = useCallback(async () => {
    try {
      setObjects(await client.list());
      setError(null);
    } catch (e) {
      setError(e instanceof ObjectsError ? e : new ObjectsError('failed'));
    }
  }, [client]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);
  const busy = !!objects?.some(o => describeObject(o).busy);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  const header = (
    <View style={styles.header}>
      <Text accessibilityRole="header" style={type.title}>
        Your things
      </Text>
      {/* A native button has no width of its own inside a row. */}
      <View style={styles.newButton}>
        <Button label="New" systemImage="plus" onPress={onNew} />
      </View>
    </View>
  );
  let body: React.ReactElement | undefined;
  if (error && !objects) {
    body = (
      <View style={styles.message}>
        <Text style={type.body}>{error.message}</Text>
        {error.kind === 'pairing' ? (
          <Button label="Connect to your Mac" onPress={onPair} />
        ) : (
          <Button label="Try again" variant="secondary" onPress={load} />
        )}
      </View>
    );
  } else if (objects && !objects.length) {
    body = (
      <View style={styles.message}>
        <Text style={type.body}>
          Nothing here yet. Tap New, then scan something or describe what you
          want made.
        </Text>
      </View>
    );
  }
  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={{
        paddingTop: insets.top + space.lg,
        paddingBottom: insets.bottom + space.xl,
        paddingLeft: insets.left + space.xl,
        paddingRight: insets.right + space.xl,
      }}
      data={objects ?? []}
      keyExtractor={o => o.id}
      ListHeaderComponent={header}
      ListEmptyComponent={body}
      onRefresh={load}
      refreshing={false}
      renderItem={({ item }) => {
        const view = describeObject(item);
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${view.title}. ${view.status}`}
            onPress={() => onOpen(item.id)}
            style={({ pressed }) => [
              styles.row,
              (pressed || selected === item.id) && styles.rowPressed,
            ]}
          >
            <Thumbnail client={client} object={item} />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={2}>
                {view.title}
              </Text>
              <Text
                style={[styles.rowStatus, { color: TONE[view.tone] }]}
                numberOfLines={2}
              >
                {view.status.split('. ')[0].replace(/\.$/, '')}
              </Text>
            </View>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.lg,
    gap: space.md,
  },
  newButton: { width: 112 },
  message: { gap: space.lg, paddingVertical: space.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
    marginHorizontal: -space.sm,
    borderRadius: radius.md,
  },
  rowPressed: { backgroundColor: colors.pressedOverlay },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: 14,
    backgroundColor: colors.viewport,
    overflow: 'hidden',
  },
  thumbImage: { width: 72, height: 72 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { ...type.body, fontWeight: '600' },
  rowStatus: { ...type.caption, fontSize: 15, lineHeight: 20 },
});
