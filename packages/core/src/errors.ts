export class NotImplementedError extends Error {
  readonly _tag = "NotImplementedError" as const;

  constructor(symbol: string) {
    super(`${symbol} is not implemented`);
    this.name = "NotImplementedError";
  }
}
