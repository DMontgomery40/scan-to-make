import React from 'react';
import { Text } from 'react-native';
import type { ListProjectsResult } from '@scan-to-make/contracts/saved-project';
import { Button, Card, Screen } from '../ui/components';
import { type } from '../ui/theme';

export function ProjectsScreen({
  result,
  error,
  onOpen,
  onCaptures,
  onBack,
  onRetry,
}: {
  result: ListProjectsResult | null;
  error: string | null;
  onOpen: (id: string) => void;
  onCaptures?: (id: string) => void;
  onBack: () => void;
  onRetry: () => void;
}) {
  return (
    <Screen
      title="Your projects"
      subtitle="Saved on this device."
      onBack={onBack}
    >
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
            <Text style={type.body}>
              Your saved ideas and measurements will appear here.
            </Text>
          ) : null}
          {result.entries.map(({ id, result: entry }) => (
            <Card key={id}>
              {entry.status === 'ok' ? (
                <>
                  <Text style={type.label}>
                    {entry.project.fit?.template === 'drawer-tray'
                      ? 'DRAWER DESIGN STUDY'
                      : entry.project.fit
                      ? 'MEASURED PROJECT'
                      : 'PROJECT BRIEF'}
                  </Text>
                  <Text style={type.heading}>
                    {entry.project.brief.object.trim() || 'Untitled project'}
                  </Text>
                  <Text style={type.caption}>
                    {entry.project.brief.addition.trim() ||
                      'An idea in progress.'}
                  </Text>
                  <Button
                    label={`Open ${
                      entry.project.brief.object.trim() || 'Untitled project'
                    }`}
                    variant="secondary"
                    onPress={() => onOpen(id)}
                  />
                  {onCaptures ? (
                    <Button
                      label="Project captures"
                      variant="secondary"
                      onPress={() => onCaptures(id)}
                    />
                  ) : null}
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
