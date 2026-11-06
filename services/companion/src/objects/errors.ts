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
/**
 * The print sheet asked for a newer estimate (other settings, same project and printer) while this one was slicing:
 * this slice was stopped. The sheet already shows the newer one, so clients drop this answer.
 */
export class EstimateSupersededError extends InvalidStateError {
  constructor() { super('A newer estimate replaced this one.'); this.name = 'EstimateSupersededError'; }
}
