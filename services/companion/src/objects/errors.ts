/** A request that doesn't fit the object's current state; its message is written for the person. */
export class InvalidStateError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidStateError'; }
}
