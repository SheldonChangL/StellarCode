export class StellarError extends Error {
  constructor(message, code = 'STELLAR_ERROR', exitCode = 1) {
    super(message)
    this.name = 'StellarError'
    this.code = code
    this.exitCode = exitCode
  }
}
