export interface TokenPair {
  accessToken: string
  refreshToken: string
}

export class TokenStore {
  private current: TokenPair | null = null

  save(tokens: TokenPair): void {
    this.current = tokens
  }

  read(): TokenPair | null {
    return this.current
  }

  clear(): void {
    this.current = null
  }
}
