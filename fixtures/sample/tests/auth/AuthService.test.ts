import { AuthService } from '../../src/auth/AuthService'
import { TokenStore } from '../../src/auth/TokenStore'
import { ApiClient } from '../../src/http/ApiClient'

export async function testRefreshFlow() {
  const service = new AuthService(new ApiClient(), new TokenStore())
  await service.login('dev@example.com', 'pw')
  return service.refreshToken()
}
