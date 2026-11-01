import type { StmObject } from './types';

export type ObjectAction =
  | 'scan'
  | 'makeIt'
  | 'printChecked'
  | 'print'
  | 'correct'
  | 'openCamera'
  | 'attachPhotos'
  | 'bestGuess'
  | 'plateClear'
  | 'retry';

export interface ObjectView {
  title: string;
  status: string;
  /** Touching up or printing: the page keeps itself up to date. */
  busy: boolean;
  tone: 'pending' | 'pass' | 'fail' | 'accent' | 'neutral';
  size?: string;
  actions: ObjectAction[];
}

const WAIT = "This can take a few minutes. We'll let you know when it's ready.";

export function objectTitle(object: StmObject): string {
  const text = object.instructions?.trim();
  if (text) {
    const first = text.split(/(?<=[.!?])\s|\n/)[0].replace(/[.!?]+$/, '');
    const line = first
      .split(/,\s*(?=[a-z])/i)
      .slice(0, 2)
      .join(', ');
    return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
  }
  return object.scan ? 'Copy of your scan' : 'Something new';
}

export function formatSize(size: [number, number, number]): string {
  return `${size.map(n => Math.round(n)).join(' × ')} mm`;
}

export function describeObject(object: StmObject): ObjectView {
  const title = objectTitle(object);
  const size = object.current?.sizeMm
    ? `${formatSize(object.current.sizeMm)}, ready to print`
    : undefined;
  const view = (
    status: string,
    tone: ObjectView['tone'],
    actions: ObjectAction[] = [],
    busy = false,
  ): ObjectView => ({ title, status, tone, actions, busy, size });
  switch (object.state) {
    case 'new':
      if (object.scan || object.photos.length)
        return view('Sending to your Mac…', 'pending', [], true);
      return view(
        'Waiting for a scan or photos.',
        'neutral',
        object.instructions?.trim()
          ? ['scan', 'attachPhotos', 'makeIt']
          : ['scan', 'attachPhotos'],
      );
    case 'touching-up': {
      const changing = object.passes.length > 1 && !!object.current;
      const what = changing
        ? 'Making your changes.'
        : object.scan
        ? 'Touching up your scan.'
        : 'Making it.';
      return view(`${what} ${WAIT}`, 'pending', [], true);
    }
    case 'needs-closeup':
      return view(
        `Can you send me a close-up of ${
          object.question?.closeup ?? 'the part I missed'
        }? I can't see what's happening there.`,
        'accent',
        ['openCamera', 'attachPhotos', 'bestGuess'],
      );
    case 'ready':
      return view('Ready to print', 'pass', ['print', 'correct']);
    case 'printing':
      if (object.plate?.noCamera)
        return view(
          'Check the plate is clear.',
          'accent',
          ['plateClear'],
          true,
        );
      if (object.plate)
        return view(
          `Looks like there's ${
            object.plate.item ?? 'something'
          } on your plate. Can you take it off first?`,
          'accent',
          ['plateClear'],
          true,
        );
      return view('Printing', 'pending', [], true);
    case 'printed':
      return view('Printed', 'pass', ['print', 'correct']);
    case 'failed':
      return view(
        object.failure?.trim() || 'Something went wrong on your Mac.',
        'fail',
        object.print?.uncertain
          ? ['printChecked', 'correct']
          : object.current
          ? ['print', 'correct']
          : ['retry'],
      );
  }
}
