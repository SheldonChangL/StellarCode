export class ApiClient {
  async login(email: string, password: string) {
    return { accessToken: 'access', refreshToken: 'refresh', email, password }
  }

  async refresh(refreshToken: string) {
    return { accessToken: 'new-access', refreshToken }
  }
}
