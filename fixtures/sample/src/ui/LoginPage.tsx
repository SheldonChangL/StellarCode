import { AuthService } from '../auth/AuthService'

export function createLoginPage(auth: AuthService) {
  return async function submit(email: string, password: string) {
    return auth.login(email, password)
  }
}
