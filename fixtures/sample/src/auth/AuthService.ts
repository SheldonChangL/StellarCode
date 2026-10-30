import { TokenStore } from './TokenStore'
import { ApiClient } from '../http/ApiClient'

export class AuthService {
  constructor(private api: ApiClient, private tokens: TokenStore) {}

  async login(email: string, password: string) {
    const result = await this.api.login(email, password)
    this.tokens.save(result)
    return result
  }

  logout() {
    this.tokens.clear()
  }

  async refreshToken() {
    const current = this.tokens.read()
    if (!current) throw new Error('No refresh token')
    const next = await this.api.refresh(current.refreshToken)
    this.tokens.save(next)
    return next
  }
}
