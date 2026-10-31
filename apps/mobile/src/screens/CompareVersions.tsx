import React, { useEffect, useMemo, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type {
  ScanArtifactName,
  ScanProcessingJob,
} from '@scan-to-make/contracts/scan-processing';
import { Badge, Button, Card } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';
import { compareVersions } from './compareVersionsModel';
import type {
  ProjectAcknowledgment,
  ScanServices,
  ScanTarget,
} from './scanServices';

/**
 * The Compare versions door (journey §3.5, P4): the scan as captured, each AI
 * try and the one picked, with pictures, plain reasons and the comparer's
 * own words. Shown only for a result that went through the AI step.
 */
export function CompareVersions({
  job,
  services,
  target,
  ack,
  gate,
  onOpenModel,
  onOpenCaptured,
}: {
  job: ScanProcessingJob;
  services: ScanServices;
  target: ScanTarget;
  ack: ProjectAcknowledgment | null;
  gate: <T>(task: () => Promise<T>) => Promise<T>;
  onOpenModel: () => void;
  /** Absent when this build can't open the scan as captured. */
  onOpenCaptured?: () => void;
}) {
  const versions = useMemo(() => compareVersions(job), [job]);
  const [open, setOpen] = useState(false);
  const [uris, setUris] = useState<Partial<Record<ScanArtifactName, string>>>(
    {},
  );
  const resolve = services.imageUri;
  useEffect(() => {
    if (!open || !versions || !ack || !resolve) return;
    let cancelled = false;
    const names = [
      ...new Set(
        versions.rows.flatMap(row => (row.preview ? [row.preview] : [])),
      ),
    ];
    (async () => {
      // One at a time: your Mac answers one request per project.
      for (const name of names) {
        try {
          if (cancelled) return;
          const uri = await gate(async () =>
            resolve(
              await services.processing.downloadArtifact(
                target.projectId,
                target.capture.captureId,
                ack,
                job,
                name,
              ),
            ),
          );
          if (!cancelled && uri)
            setUris(current => ({ ...current, [name]: uri }));
        } catch {
          // A picture that won't load keeps its plain tile; the words still say it all.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, versions, ack, resolve, services, target, job, gate]);
  if (!versions) return null;
  return (
    <Card>
      <Text style={type.heading}>Versions</Text>
      <Text style={type.caption}>{versions.summary}</Text>
      {open ? (
        <>
          {versions.rows.map(row => {
            const uri = row.preview ? uris[row.preview] : undefined;
            return (
              <View key={row.key} style={styles.row}>
                {uri ? (
                  <Image
                    source={{ uri }}
                    style={styles.thumb}
                    accessibilityLabel={`Picture of ${row.title.toLowerCase()}`}
                  />
                ) : (
                  <View
                    style={[styles.thumb, styles.tile]}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                  />
                )}
                <View style={styles.flex}>
                  <View style={styles.titleRow}>
                    <Text style={[type.body, styles.flex]}>{row.title}</Text>
                    {row.picked ? <Badge label="Picked" tone="pass" /> : null}
                  </View>
                  <Text style={type.caption}>{row.note}</Text>
                  {row.open === 'model' ||
                  (row.open === 'captured' && onOpenCaptured) ? (
                    <Button
                      label="Open in 3D"
                      variant="secondary"
                      accessibilityLabel={`Open ${row.title.toLowerCase()} in 3D`}
                      onPress={
                        row.open === 'model' ? onOpenModel : onOpenCaptured!
                      }
                    />
                  ) : null}
                </View>
              </View>
            );
          })}
          {versions.reason ? (
            <View style={styles.reason}>
              <Text style={type.label}>WHY THIS ONE</Text>
              <Text style={type.body}>{versions.reason}</Text>
              <Text style={type.caption}>
                The versions were compared without their names, so they’re
                called A, B and so on.
              </Text>
            </View>
          ) : null}
          <Button
            label="Hide versions"
            variant="secondary"
            onPress={() => setOpen(false)}
          />
        </>
      ) : (
        <Button
          label="Compare versions"
          variant="secondary"
          accessibilityHint="Shows the scan as captured, each AI try and the one picked."
          onPress={() => setOpen(true)}
        />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: {
    flexDirection: 'row',
    gap: space.md,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  thumb: { width: 88, height: 88, borderRadius: radius.md },
  tile: { backgroundColor: colors.sage },
  reason: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
});
