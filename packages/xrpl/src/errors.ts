export class InsufficientFunds extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientFunds";
  }
}

export class NoLiquidity extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoLiquidity";
  }
}

export class TrustlineMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustlineMissing";
  }
}

export class LedgerRejected extends Error {
  public readonly code: string;
  public readonly hash?: string;

  constructor(code: string, message: string, hash?: string) {
    super(`Ledger transaction rejected [${code}]: ${message}${hash ? ` (tx: ${hash})` : ""}`);
    this.name = "LedgerRejected";
    this.code = code;
    this.hash = hash;
  }
}
