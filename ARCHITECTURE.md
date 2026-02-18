# MiID Architecture

이 문서는 MiID 분산 신원 인증 시스템의 아키텍처를 설명합니다.

## 액터

| 액터 | 설명 |
|------|------|
| User | 최종 사용자. 승인/거부 의사결정 |
| Browser | 서비스 UI 렌더링, 세션 쿠키(sid) 보관 |
| Service Frontend | 로그인 UI, 대기 상태 표시, SSE 수신 |
| Service Backend | Challenge 요청, Gateway SSE 구독, Token exchange, 서비스 세션 발급 |
| Auth Gateway | Challenge/Approval/Token/Session 상태 관리, SSE 이벤트 발행 |
| Auth Wallet | Electron 데스크톱 앱. 로컬 키 보관, 사용자 승인, 자동 승인 정책 관리 |

## 1) High-Level Component Diagram

```mermaid
flowchart TB
    subgraph "User Device"
        U["User"]
        B["Browser"]
        AW["Auth Wallet<br/>(Electron App)"]
        WS["Wallet Server<br/>(embedded)"]
    end

    subgraph "Service"
        SF["Service Frontend<br/>:3000"]
        subgraph "Service Backend Architecture"
            SB["Service Backend<br/>:15000"]
            SDB[("service-backend.db")]
            RD[("Redis Store")]
            SB --- SDB
            SB --- RD
        end
    end

    subgraph "Auth Gateway Architecture"
        AG["Auth Gateway<br/>:14000"]
        GDB[("gateway.db")]
        AG --- GDB
    end

    U -->|"interacts"| B
    U -->|"approve/deny"| AW
    B -->|"loads UI"| SF
    SF -->|"API calls"| SB
    SB -->|"1. challenge<br/>2. SSE subscribe<br/>3. token exchange"| AG
    AG -->|"wallet SSE<br/>(by DID)"| AW
    AW -->|"sign & approve"| AG
    AW -->|"uses"| WS
    AG -->|"DID resolution"| WS
    SB -->|"auth stream SSE"| SF
    SB -->|"Set-Cookie: sid"| B
```

## 2) Data Flow Overview

```mermaid
flowchart LR
    subgraph "Challenge Flow"
        C1["Challenge Created"] --> C2["Pending"]
        C2 --> C3["Approved/Denied"]
    end

    subgraph "Session Flow"
        S1["Auth Code Issued"] --> S2["Token Exchange"]
        S2 --> S3["Active Service Created"]
    end

    subgraph "SSE Streams"
        SSE1["Gateway→Wallet<br/>/v1/wallet/events"]
        SSE2["Gateway→Service<br/>/v1/service/events"]
        SSE3["Gateway→Service<br/>/v1/service/session-events"]
        SSE4["Backend→Frontend<br/>/auth/stream/:id"]
        SSE5["Backend→Frontend<br/>/session/stream"]
    end
```

## 3) End-to-End Login Sequence

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant Frontend as Service Frontend
    participant Backend as Service Backend
    participant Gateway as Auth Gateway
    participant Wallet as Auth Wallet
    participant WalletServer as Wallet Server

    Note over User,WalletServer: 1. Login 시작
    User->>Browser: Open login page
    Browser->>Frontend: Render login screen
    Frontend->>Backend: POST /auth/start

    Note over Backend: Local Wallet Health Check
    Backend->>WalletServer: GET /health
    WalletServer-->>Backend: { ok: true }

    Backend->>Gateway: POST /v1/auth/challenge<br/>(X-Client-Id, X-Client-Secret)
    Gateway-->>Backend: challenge_id, nonce, expires_at

    Note over Backend,Gateway: 2. SSE 구독 시작
    Backend->>Gateway: GET /v1/service/events?challenge_id=...
    Backend-->>Frontend: { challenge_id, stream_url, status: pending }
    Frontend->>Backend: GET /auth/stream/:challengeId (SSE)

    Note over Gateway,Wallet: 3. Wallet 이벤트 전달
    Gateway-->>Wallet: challenge_created (SSE)

    alt 자동 승인 (기존 활성 서비스 존재)
        Wallet->>Wallet: Check existing active services
        Wallet->>Wallet: Get claim policy for (DID, serviceId)
        Wallet->>WalletServer: POST /v1/wallets/sign
        WalletServer-->>Wallet: { signature }
        Wallet->>Gateway: POST /v1/wallet/challenges/:id/approve
        Wallet-->>User: Auto-approved notification
    else 수동 승인 필요
        Wallet-->>User: Approval notification
        User->>Wallet: Select DID, claims, Approve
        Wallet->>WalletServer: POST /v1/wallets/sign
        WalletServer-->>Wallet: { signature }
        Wallet->>Gateway: POST /v1/wallet/challenges/:id/approve
    end

    Note over Gateway,Backend: 4. 검증 완료 및 토큰 교환
    Gateway->>WalletServer: GET /v1/wallets/by-did/:did
    WalletServer-->>Gateway: { public_key_pem, profile }
    Gateway->>Gateway: Verify signature with DID Document
    Gateway->>Gateway: Issue authorization_code
    Gateway-->>Backend: challenge_verified (SSE)<br/>{ authorization_code }

    Backend->>Gateway: POST /v1/token/exchange<br/>{ code, client_id, redirect_uri }
    Gateway-->>Backend: { access_token, refresh_token, session_id }

    Backend->>Gateway: GET /v1/services/:serviceId/profile<br/>(Bearer token)
    Gateway-->>Backend: { subject_id, did, name, email, ... }

    Note over Backend,Browser: 5. 세션 생성 및 완료
    Backend-->>Frontend: active (SSE)<br/>{ session_id, profile }
    Frontend->>Backend: POST /auth/complete/:challengeId
    Backend-->>Browser: Set-Cookie: sid=...
    Browser->>Backend: Authenticated requests with sid
```

## 4) Auto-Approval Flow

Wallet은 동일 서비스에 기존 active 세션이 있을 때 자동 승인을 수행합니다.

```mermaid
flowchart TD
    CE["challenge_created event"] --> CH{"did_hint 있음?"}
    CH -->|Yes| TD["targetDid = did_hint"]
    CH -->|No| WC{"wallet 1개만 존재?"}
    WC -->|Yes| TD2["targetDid = 유일 DID"]
    WC -->|No| FA["findAutoApproveDid()"]
    FA --> TD3["targetDid = 기존 세션 있는 DID"]

    TD --> SA["shouldAutoApproveChallenge()"]
    TD2 --> SA
    TD3 --> SA

    SA --> SAR{"기존 세션에<br/>요청 scope 포함?"}
    SAR -->|Yes| GAC["getAutoApprovedClaims()"]
    SAR -->|No| MN["showApproveNotification()"]

    GAC --> CP{"Claim Policy 존재?"}
    CP -->|Yes| FP["policy 기준 claims 필터"]
    CP -->|No| FS["기존 세션 approved_claims 기준 필터"]

    FP --> AA["Auto-approve"]
    FS --> AA
    AA --> AN["showAutoApprovedNotification()"]
```

## 5) State Machine

```mermaid
stateDiagram-v2
    [*] --> Pending: challenge created

    Pending --> Approved: wallet approves<br/>(auth_code issued)
    Pending --> Denied: wallet denies
    Pending --> Expired: TTL timeout

    Approved --> Pending: wallet cancels approval
    Approved --> Active: service backend<br/>token exchange
    Approved --> Expired: auth_code TTL timeout

    Active --> Revoked: wallet revokes session

    Denied --> [*]
    Expired --> [*]
    Revoked --> [*]
```

## 6) SSE Event Streams

### Gateway → Wallet (`/v1/wallet/events?did=`)

| Event | Trigger | Payload |
|-------|---------|---------|
| `challenge_created` | 새 challenge 생성 | challenge_id, service_id, scopes, requested_claims |
| `challenge_approved` | 본인 승인 완료 | challenge_id, authorization_code |
| `challenge_denied` | 본인 거부 | challenge_id |
| `session_created` | 세션 생성 | session_id, service_id, scope |
| `session_revoked` | 세션 revoke | session_id, service_id |
| `approved_cancelled` | 승인 취소 | challenge_id, authorization_code |
| `login_reused` | 세션 재사용 로그인 | service_id, scopes |

### Gateway → Service Backend (`/v1/service/events?challenge_id=`)

| Event | Payload |
|-------|---------|
| `challenge_verified` | authorization_code, service_id, client_id |
| `challenge_denied` | challenge_id, service_id |
| `challenge_expired` | challenge_id |

### Gateway → Service Backend (`/v1/service/session-events`)

| Event | Payload |
|-------|---------|
| `session_created` | session_id, service_id, subject_id, did |
| `session_revoked` | session_id, service_id, subject_id, did |

### Service Backend → Frontend (`/auth/stream/:challengeId`)

| Event | Payload |
|-------|---------|
| `snapshot` | 현재 상태 스냅샷 |
| `approved` | authorization_code, verified_at |
| `active` | session_id, profile |
| `denied` | challenge_id |
| `expired` | challenge_id |
| `error` | error message |

### Service Backend → Frontend (`/session/stream`)

| Event | Payload |
|-------|---------|
| `force_logout` | reason: "revoked", session_id |

## 7) Component Architecture

### Auth Wallet (Electron App)

```mermaid
flowchart TB
    subgraph "Electron Main Process"
        M["main.js"]
        T["Tray Menu"]
        IPC["IPC Handlers"]
        ES["EventSource<br/>(Gateway SSE)"]
    end

    subgraph "Renderer Process"
        UI["Wallet UI<br/>(renderer.js)"]
    end

    subgraph "Embedded Server"
        WS["Wallet Server<br/>(server.js)"]
        DB["wallet.json"]
    end

    M --> T
    M --> IPC
    M --> ES
    IPC <--> UI
    M --> WS
    WS --> DB

    ES -->|"challenge events"| IPC
    IPC -->|"challenge:event"| UI
```

### Auth Gateway

```mermaid
flowchart TB
    subgraph "API Endpoints"
        A1["/v1/auth/challenge"]
        A2["/v1/auth/verify"]
        A3["/v1/token/exchange"]
        A4["/v1/wallet/challenges/:id/approve"]
        A5["/v1/wallet/challenges/:id/deny"]
    end

    subgraph "SSE Endpoints"
        S1["/v1/wallet/events"]
        S2["/v1/service/events"]
        S3["/v1/service/session-events"]
    end

    subgraph "Data Store"
        DS[("gateway.db")]
        CH["challenges"]
        AC["authCodes"]
        SU["subjects"]
        CO["consents"]
        SE["sessions"]
    end

    DS --- CH
    DS --- AC
    DS --- SU
    DS --- CO
    DS --- SE
```

### Service Backend

Service Backend는 서비스 설정 및 클라이언트 정보를 SQLite에 저장하고, 런타임 세션 정보를 Redis에 캐싱합니다.

```mermaid
flowchart TB
    subgraph "API & Logic"
        API["Express App"]
        SH["SSE Hub"]
        RC["Redis Client"]
    end

    subgraph "Persistent Store"
        SDB[("service-backend.db")]
        SC["service_configs"]
    end

    subgraph "Runtime Store (Redis)"
        RD[("Redis")]
        RS["sessions"]
        RCH["challenges"]
    end

    API --> SDB
    SDB --> SC
    API --> RC
    RC --> RD
    RD --> RS
    RD --> RCH
```

### Service Client Authentication

Service Backend는 Gateway API 호출 시 클라이언트 인증이 필요합니다.

```mermaid
sequenceDiagram
    participant SB as Service Backend
    participant AG as Auth Gateway

    SB->>AG: POST /v1/auth/challenge
    Note over SB,AG: Headers:<br/>X-Client-Id: web-client<br/>X-Client-Secret: dev-service-secret<br/>X-Local-Wallet-Ready: 1

    AG->>AG: Validate client credentials
    AG->>AG: Check wallet connectivity
    AG-->>SB: 201 Created / 401 Unauthorized
```

## 9) Claim Policy System

Wallet은 서비스별로 어떤 claims을 자동 공유할지 정책을 저장합니다.

```mermaid
flowchart LR
    subgraph "Claim Policy Storage"
        CP["claim-policies.json"]
        K["key: did::serviceId"]
        V["value: [claims]"]
    end

    subgraph "Policy Lookup"
        GCP["getClaimPolicy()"]
        SCP["setClaimPolicy()"]
    end

    GCP --> CP
    SCP --> CP
    K --> V
```

**정책 적용 우선순위:**
1. 저장된 claim policy (did + serviceId)
2. 기존 세션의 approved_claims
3. 요청된 모든 claims (기본값)

## 10) Security Notes

- **서명**: Wallet 로컬 Ed25519 키로만 수행
- **승인 없이 finalize 불가**: `Approved` 상태에서만 token exchange 가능
- **서비스 로그인 판정**: `Active session + valid sid`
- **브라우저**: `sid`만 유지, 민감 토큰은 서비스 백엔드 저장
- **서비스 인증**: X-Client-Id + X-Client-Secret 헤더
- **로컬 월렛 필수**: LOCAL_WALLET_REQUIRED 환경 변수로 제어
- **DID Method**: `did:miid` (데모용 로컬 방식)

## 11) Port Configuration

| Component | Default Port | Environment Variable |
|-----------|--------------|---------------------|
| Auth Gateway | 14000 | GATEWAY_PORT |
| Service Backend | 15000 | PORT |
| Wallet Server | 17000 | WALLET_PORT |
| Service Frontend | 3000 | (proxy via server.js) |

## 12) Environment Variables

### Gateway
- `GATEWAY_PORT`: Gateway 포트 (기본 14000)
- `GATEWAY_DB_FILE`: SQLite 데이터베이스 경로 (data/gateway.db)
- `DEBUG_AUTH`: 디버그 로그 활성화
- `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET`: 서비스 클라이언트 인증
- `REQUIRE_WALLET_APPROVAL_FOR_REUSE`: 세션 재사용 시 월렛 승인 필요 여부
- `LOCAL_WALLET_REQUIRED`: 로컬 월렛 연결 필수 여부

### Wallet
- `WALLET_PORT`: Wallet 서버 포트 (기본 17000)
- `GATEWAY_URL`: Gateway URL
- `MIID_DATA_DIR`: 데이터 저장 경로
- `MIID_POPUP_ON_CHALLENGE`: challenge 시 윈도우 팝업 여부
- `MIID_HIDE_DOCK`: macOS dock 아이콘 숨김

### Service Backend
- `PORT`: Backend 포트 (기본 15000)
- `GATEWAY_URL`: Gateway URL
- `LOCAL_WALLET_URL`: 로컬 월렛 URL
- `LOCAL_WALLET_REQUIRED`: 로컬 월렛 필수 여부
- `REDIS_URL`: Redis 저장소 URL (기본 redis://127.0.0.1:6379)
- `SERVICE_DB_FILE`: 서비스 설정 DB 경로 (data/service-backend.db)
- `CLIENT_ID`, `CLIENT_SECRET`: Gateway 인증 정보 (초기값)
- `SERVICE_ID`: 서비스 식별자 (초기값)
- `SERVICE_AUTO_FINALIZE`: 자동 finalize 여부
- `REQUESTED_CLAIMS`: 요청할 claims (쉼표 구분, 초기값)

**동적 설정 변수** (런타임에 `/service/manage` API로 변경 가능):
- `CURRENT_SERVICE_ID`: 현재 사용 중인 서비스 ID
- `CURRENT_CLIENT_ID`: 현재 사용 중인 클라이언트 ID
- `DYNAMIC_REQUESTED_CLAIMS`: 현재 요청할 claims 목록

## 13) Frontend Profile Rendering

프론트엔드는 프로필 정보를 동적으로 렌더링합니다.

```mermaid
flowchart TD
    PR["renderProfile(profile)"] --> RC["requested_claims 순회"]
    RC --> CHK{"profile[claim] 존재?"}
    CHK -->|Yes| SHOW["값 표시"]
    CHK -->|No| DASH["'-' 표시 (회색)"]
    SHOW --> NEXT["다음 claim"]
    DASH --> NEXT
    NEXT --> RC
```

**렌더링 규칙:**
1. `requested_claims` 배열의 모든 항목을 표시
2. `approved_claims`에 포함되고 값이 있으면 정상 표시
3. 승인되지 않았거나 값이 없으면 `-`로 표시 (회색)
4. 고정 필드: Service ID, Risk Level은 항상 표시

**예시 응답:**
```json
{
  "requested_claims": ["name", "email", "phone"],
  "approved_claims": ["name", "email"],
  "name": "홍길동",
  "email": "user@example.com"
}
```

**렌더링 결과:**
| Field | Value | Style |
|-------|-------|-------|
| name | 홍길동 | 정상 |
| email | user@example.com | 정상 |
| phone | - | 회색 |

## 14) Dynamic Service Configuration

서비스 백엔드는 런타임에 서비스 설정을 변경할 수 있습니다.

```mermaid
sequenceDiagram
    participant UI as Service Frontend
    participant BE as Service Backend
    participant GW as Gateway

    UI->>BE: POST /service/manage<br/>{service_id, requested_fields}
    BE->>GW: POST /v1/services<br/>(새 서비스 등록)
    GW-->>BE: 등록 완료
    BE->>BE: CURRENT_SERVICE_ID 업데이트
    BE->>BE: CURRENT_CLIENT_ID 업데이트
    BE->>BE: DYNAMIC_REQUESTED_CLAIMS 업데이트
    BE-->>UI: {success: true}

    Note over UI,GW: 이후 로그인은 새 설정으로 수행
    UI->>BE: POST /auth/start
    BE->>GW: POST /v1/auth/challenge<br/>(새 service_id, client_id, claims)
```

**주의사항:**
- EventSource 연결 시에도 `CURRENT_CLIENT_ID`를 사용하여 인증
- 서비스 설정 변경 후 기존 EventSource 연결은 유지됨 (재연결 시 새 설정 적용)

## TODO

- [ ] 서비스 식별자(`service_id`)를 `service DID` 기반으로 전환
- [ ] 멀티테넌시 격리 (tenant 경계 기반 subject/session/consent 분리)
- [ ] 서비스 인증 강화 (`private_key_jwt` 또는 mTLS, 키 회전)
- [ ] DID resolver/신뢰앵커 기반 공개키 검증 (`did:miid` 보강)
- [ ] 정책 엔진 분리 (서비스별 승인 재사용 TTL, step-up, 리스크 룰)
- [ ] 이벤트 전달 신뢰성 강화 (SSE 재연/복구 또는 큐 기반 보장)
- [ ] 감사/모니터링 체계 (승인/거절/revoke 추적, 경보, 보관 정책)
