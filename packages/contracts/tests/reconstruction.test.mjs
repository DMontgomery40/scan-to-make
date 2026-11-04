import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  CaptureCameraSchema, CaptureMeasurementSchema, CaptureObjectRegionSchema,
  ReconstructionAnswerSchema, ReconstructionReviewSchema,
} from '../dist/reconstruction.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/reconstruction-v1.json', import.meta.url), 'utf8'));

test('reconstruction v1 fixtures parse', () => {
  CaptureCameraSchema.parse(fixture.captureCamera);
  ReconstructionReviewSchema.parse(fixture.regionReview);
  ReconstructionReviewSchema.parse(fixture.scaleReview);
  ReconstructionAnswerSchema.parse(fixture.regionAnswer);
  ReconstructionAnswerSchema.parse(fixture.scaleAnswer);
  CaptureObjectRegionSchema.parse(fixture.objectRegion);
  CaptureMeasurementSchema.parse(fixture.measurement);
});

test('capture-camera is strict: unknown keys, bad hashes, non-finite centres refused', () => {
  const base = fixture.captureCamera;
  assert.throws(() => CaptureCameraSchema.parse({...base, extra: 1}));
  assert.throws(() => CaptureCameraSchema.parse({...base, frames: [{...base.frames[0], sha256: 'A'.repeat(64)}]}));
  assert.throws(() => CaptureCameraSchema.parse({...base, frames: [{...base.frames[0], center: [Infinity, 0, 0]}]}));
  assert.throws(() => CaptureCameraSchema.parse({...base, frames: [{...base.frames[0], image: '../x.jpg'}]}));
});

test('review preview is a route, never a path; answers are bounded', () => {
  assert.throws(() => ReconstructionReviewSchema.parse({...fixture.regionReview, preview: '/abs/work/preview.stl'}));
  assert.throws(() => ReconstructionAnswerSchema.parse({type: 'scale', meshSha256: 'c'.repeat(64), axis: 'x', extentMm: 0.5}));
  assert.throws(() => ReconstructionAnswerSchema.parse({type: 'region', previewMeshSha256: 'b'.repeat(64), selection: {type: 'crop', min: [0, 0, NaN], max: [1, 1, 1]}}));
});
