# Wireframes

## 1. Universe overview

```text
+--------------------------------------------------------------------------------------+
| ✦ StellarCode   my-project        [ Search files or symbols…  ⌘K ]   Sync ✓     ⚙   |
+--------------------+------------------------------------------------+----------------+
| PROJECT            |                                                | REPOSITORY     |
|                    |                 tests · · ·                    | 182 files      |
| src             94 |                     \                          | 541 relations  |
| tests           31 |                      \                         | 23 changed     |
| docs            18 |            . . .  SRC NEBULA . . .            |                |
| infra            9 |                 ·      ★ core                  | CORE MODULES   |
|                    |              ·        / | \       ·           | src/auth       |
| RELATIONS          |          auth ● ----- ● api ----- ● ui        | src/api        |
| ☑ imports          |              \       |       /                | src/ui         |
| ☑ references       |               \      ● session                |                |
| ☑ tests            |                                                |                |
| ☐ all edges        |        docs · · ·             infra · · ·     |                |
|                    |                                                |                |
+--------------------+------------------------------------------------+----------------+
| Universe          Relations             Changes            Graph v42 |  Up to date    |
+--------------------------------------------------------------------------------------+
```

## 2. File focus

```text
+--------------------------------------------------------------------------------------+
| ✦ StellarCode  / src / auth / AuthService.ts                    Focus mode      ×    |
+--------------------+--------------------------------------------+--------------------+
| RELATED            |                                            | AuthService.ts     |
|                    |                 TokenStore ●                | src/auth/...       |
| Direct           4 |                       │                    |                    |
| Reverse          6 |                       │                    | Authentication     |
| Tests            1 | UserAPI ● ─────── ★ AuthService ─── ● LoginPage              |
|                    |                       │                    |                    |
| Depth             1 |                       │                    | 214 LOC            |
|                    |                 ● SessionManager           | 8 in / 3 out       |
|                    |                       ⋮                    | modified 2d ago    |
|                    |                 ◌ AuthService.test         |                    |
|                    |                                            | SYMBOLS            |
|                    |                                            | login()            |
|                    |                                            | logout()           |
|                    |                                            | refreshToken()     |
|                    |                                            |                    |
|                    |                                            | [Show Impact]      |
+--------------------+--------------------------------------------+--------------------+
```

## 3. Search palette

```text
                    +------------------------------------------------+
                    | Search StellarCode                             |
                    | > refresh token                                |
                    +------------------------------------------------+
                    | FILES                                          |
                    | ★ AuthService.ts                               |
                    |   Authentication orchestration                 |
                    | ● TokenStore.ts                                |
                    |   Token persistence / refresh                  |
                    |                                                |
                    | SYMBOLS                                        |
                    | ƒ refreshToken()                               |
                    |   src/auth/AuthService.ts:82                    |
                    |                                                |
                    | TESTS                                          |
                    | ◌ AuthService.test.ts                          |
                    +------------------------------------------------+
```

## 4. Impact mode

```text
+--------------------------------------------------------------------------------------+
| IMPACT: AuthService.ts       Depth [2]      Direct 4  Indirect 9  Tests 3             |
+--------------------------------------------------------------------------------------+
|                                                                                      |
|                               ● TokenStore                                           |
|                                   │                                                  |
|                                   ▼                                                  |
|                              ★ AuthService                                           |
|                            ╱       │       ╲                                          |
|                           ▼        ▼        ▼                                         |
|                      LoginPage  Session   ApiRoute                                    |
|                          │         │         │                                         |
|                          ▼         ▼         ▼                                         |
|                        App.ts   Router.ts  IntegrationTest                             |
|                                                                                      |
| Legend: solid direct | dim indirect | dotted test                                    |
+--------------------------------------------------------------------------------------+
```

## 5. Changes

```text
+--------------------------------------------------------------------------------------+
| CHANGES                                              [ working tree ] [ commits ]      |
+--------------------------------------------------------------------------------------+
| Oct 30  15:02   AuthService.ts       +18 -7     refresh retry                        |
|                 TokenStore.ts        +11 -2                                          |
|                 AuthService.test.ts  +26 -0                                          |
|                                                                                      |
| Oct 29  09:44   ApiClient.ts         +4 -3      timeout cleanup                      |
+--------------------------------------------------------------------------------------+
```

## 6. Settings / storage

```text
+--------------------------------------------------------------------------------------+
| PROJECT SETTINGS                                                                    |
+--------------------------------------------------------------------------------------+
| Project ID     c64db2a8-...                                                          |
| Repository     /Users/.../my-project                                                 |
| Index DB       ~/Library/Application Support/StellarCode/projects/<uuid>/index.db     |
| Graph version  42                                                                    |
|                                                                                      |
| Ignore rules   [ Edit .stellarignore ]                                                |
|                                                                                      |
| Index size     38 MB                                                                 |
| Cache          12 MB    [Clear cache]                                                 |
|                                                                                      |
| [Reindex project]                                                                    |
+--------------------------------------------------------------------------------------+
```
