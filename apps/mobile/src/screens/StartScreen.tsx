import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, Field, Screen } from '../ui/components';
import { colors, space, type } from '../ui/theme';
import { ObjectsError, type ObjectsClient } from '../objects/client';
import type { ObjectCapture } from '../objects/capture';

/**
 * Starting something: what to make (optional), then a scan, photos, or
 * nothing more when the description names a product with published sizes.
 */
export function StartScreen({
  client,
  capture,
  onBack,
  onStarted,
  onPair,
}: {
  client: ObjectsClient;
  capture: ObjectCapture;
  onBack: () => void;
  onStarted: (id: string) => void;
  onPair: () => void;
}) {
  const [instructions, setInstructions] = useState('');
  const [canScan, setCanScan] = useState<boolean | null>(null);
  const [working, setWorking] = useState<'scan' | 'photos' | 'make' | null>(
    null,
  );
  const [problem, setProblem] = useState<ObjectsError | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    capture.available().then(setCanScan, () => setCanScan(false));
  }, [capture]);

  const begin = async (kind: 'scan' | 'photos' | 'make') => {
    // A ref, not state: a double tap lands before the next render.
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(kind);
    setProblem(null);
    let id: string | null = null;
    try {
      const object = await client.create(instructions);
      id = object.id;
      if (kind === 'scan') {
        const runID = await capture.scan(object.id);
        if (runID) await client.sendCapture(object.id, runID);
      } else if (kind === 'photos') {
        if (await client.pickPhotos(object.id, 12))
          await client.start(object.id);
      } else await client.start(object.id);
      onStarted(object.id);
    } catch (e) {
      const error = e instanceof ObjectsError ? e : new ObjectsError('failed');
      // Once it exists, its own page says what's left to do.
      if (id && error.kind !== 'pairing') onStarted(id);
      else setProblem(error);
    } finally {
      inFlight.current = false;
      setWorking(null);
    }
  };
  const described = !!instructions.trim();
  return (
    <Screen title="What do you want to make?" onBack={onBack}>
      <Field
        label="Describe it"
        hint="Leave it empty to make a copy of what you scan. Product names, model numbers and links all help."
        placeholder="A hook for my stroller handle that holds a cup"
        value={instructions}
        onChangeText={setInstructions}
        multiline
        maxLength={8000}
        autoCorrect
      />
      <View style={styles.actions}>
        {canScan ? (
          <Button
            label={working === 'scan' ? 'Sending to your Mac…' : 'Scan it'}
            systemImage="viewfinder"
            disabled={!!working}
            onPress={() => begin('scan')}
          />
        ) : null}
        <Button
          label={working === 'photos' ? 'Sending to your Mac…' : 'Use photos'}
          variant={canScan ? 'secondary' : 'primary'}
          systemImage="photo.on.rectangle"
          disabled={!!working}
          onPress={() => begin('photos')}
        />
        {described ? (
          <Button
            label={
              working === 'make'
                ? 'Sending to your Mac…'
                : 'Make it from the description'
            }
            variant="secondary"
            disabled={!!working}
            onPress={() => begin('make')}
          />
        ) : null}
      </View>
      {canScan === false ? (
        <Text style={styles.note}>
          Scanning needs an iPhone or iPad with LiDAR.
        </Text>
      ) : null}
      {problem ? (
        <View accessibilityLiveRegion="assertive" style={styles.problem}>
          <Text style={styles.problemText}>{problem.message}</Text>
          {problem.kind === 'pairing' ? (
            <Button label="Connect to your Mac" onPress={onPair} />
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { marginTop: space.xl, gap: space.md },
  note: { ...type.caption, marginTop: space.lg },
  problem: { marginTop: space.lg, gap: space.md },
  problemText: { ...type.body, color: colors.fail },
});
