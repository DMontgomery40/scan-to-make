/** A request that doesn't fit the object's current state; its message is written for the person. */
export class InvalidStateError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidStateError'; }
}
/**
 * Bambu Studio refused to slice the model (KAN-223 `slicer-error`); the message is Studio's own words. Still an
 * InvalidStateError (409 on HTTP); the control socket names it `slicer-error` so the Mac can hold Print for that file.
 */
export class SlicerRefusedError extends InvalidStateError {
  constructor(message: string) { super(message); this.name = 'SlicerRefusedError'; }
}
