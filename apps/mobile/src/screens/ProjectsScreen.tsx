import React, { useState } from 'react';
import { Text } from 'react-native';
import type { ListProjectsResult } from '@scan-to-make/contracts/saved-project';
import { Button, Card, Field, Screen } from '../ui/components';
import { type } from '../ui/theme';

export function ProjectsScreen({
  result,
  error,
  creating,
  onCreate,
  onOpen,
  onBack,
  onRetry,
}: {
  result: ListProjectsResult | null;
  error: string | null;
  creating: boolean;
  onCreate: (name: string) => Promise<boolean>;
  onOpen: (id: string) => void;
  onBack: () => void;
  onRetry: () => void;
}) {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  return (
    <Screen
      title="Your projects"
      subtitle="One project for each object you scan. Saved on this device."
      onBack={creating ? undefined : onBack}
    >
      <Card>
        <Text style={type.heading}>New project</Text>
        <Field
          label="What are you scanning?"
          hint="For example, a phone case or a desk lamp."
          value={name}
          onChangeText={setName}
          editable={!creating}
          maxLength={200}
          returnKeyType="done"
        />
        <Button
          label={creating ? 'Creating…' : 'Create and scan'}
          disabled={creating || !trimmed}
          onPress={async () => {
            if (await onCreate(trimmed)) setName('');
          }}
        />
      </Card>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={type.body}>
          {error}
        </Text>
      ) : null}
      {!result ? (
        <Text style={type.body}>Loading projects…</Text>
      ) : result.status === 'storage-error' ? (
        <Card>
          <Text style={type.heading}>Projects couldn’t be loaded.</Text>
          <Text style={type.body}>Your saved data hasn’t been changed.</Text>
          <Button label="Try loading again" onPress={onRetry} />
        </Card>
      ) : (
        <>
          {result.entries.length === 0 ? (
            <Text style={type.body}>Your scan projects will appear here.</Text>
          ) : null}
          {result.entries.map(({ id, result: entry }) => (
            <Card key={id}>
              {entry.status === 'ok' ? (
                <>
                  <Text style={type.heading}>
                    {entry.project.brief.object.trim() || 'Untitled project'}
                  </Text>
                  <Button
                    label="Open scans"
                    accessibilityLabel={`Open scans for ${
                      entry.project.brief.object.trim() || 'Untitled project'
                    }`}
                    variant="secondary"
                    onPress={() => onOpen(id)}
                  />
                </>
              ) : (
                <>
                  <Text style={type.heading}>
                    {entry.status === 'unsupported-version'
                      ? 'This project needs a newer app.'
                      : entry.status === 'corrupt'
                      ? 'This project couldn’t be read.'
                      : 'This project is unavailable.'}
                  </Text>
                  <Text style={type.caption}>
                    Stored data is kept unchanged. Other projects are still
                    available.
                  </Text>
                  <Text selectable style={type.caption}>
                    {id}
                  </Text>
                </>
              )}
            </Card>
          ))}
          <Button
            label="Refresh projects"
            variant="secondary"
            onPress={onRetry}
          />
        </>
      )}
    </Screen>
  );
}
