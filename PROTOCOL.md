# MiID Protocol Specification

이 문서는 MiID 시스템의 컴포넌트 간 통신 프로토콜을 정의합니다.

## 목차

1. [개요](#1-개요)
2. [Service Frontend ↔ Service Backend](#2-service-frontend--service-backend)
3. [Service Backend ↔ Gateway](#3-service-backend--gateway)
4. [Gateway ↔ Wallet (SSE)](#4-gateway--wallet-sse)
5. [Wallet → Gateway (API)](#5-wallet--gateway-api)
6. [Gateway/Wallet App → Wallet Server](#6-gatewaywallet-app--wallet-server)
7. [공통 규격](#7-공통-규격)

---

## 1. 개요

### 1.1 통신 구조

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Service         │     │ Service         │     │ Auth            │     │ Auth            │
│ Frontend        │◄───►│ Backend         │◄───►│ Gateway         │◄───►│ Wallet          │
│ :3000           │     │ :15000          │     │ :14000          │     │ (Electron)      │
└─────────────────┘     └─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │                       │
                                                        │                       ▼
                                                        │               ┌─────────────────┐
                                                        └──────────────►│ Wallet Server   │
                                                                        │ :17000          │
                                                                        └─────────────────┘
```

### 1.2 공통 헤더

| Header | 용도 |
|--------|------|
| `Content-Type: application/json` | JSON 요청/응답 |
| `X-Client-Id` | Service Client 식별자 |
| `X-Client-Secret` | Service Client 비밀키 |
| `X-Local-Wallet-Ready` | 로컬 월렛 연결 상태 (`0` or `1`) |
| `X-Wallet-Sign-Secret` | Wallet 서명 요청 인증 |
| `Authorization: Bearer <token>` | Access Token 인증 |

### 1.3 공통 에러 응답

```json
{
  "error": "error_code",
  "message": "Human readable message (optional)"
}
```

---

## 2. Service Frontend ↔ Service Backend

### 2.1 POST /auth/start

로그인 프로세스를 시작합니다.

**Request**
```http
POST /api/auth/start HTTP/1.1
Content-Type: application/json

{
  "did": "did:miid:xxx"  // optional, DID hint
}
```

**Response (201 Created)**
```json
{
  "challenge_id": "uuid",
  "nonce": "random_base64url_string",
  "expires_at": "2024-01-01T12:05:00.000Z",
  "stream_url": "/auth/stream/uuid",
  "status": "pending"
}
```

**Error Responses**

| Status | Error Code | 설명 |
|--------|------------|------|
| 409 | `wallet_local_unreachable` | 로컬 월렛 미연결 |
| 500 | `auth_start_failed` | 내부 오류 |

---

### 2.2 GET /auth/stream/:challengeId (SSE)

Challenge 상태 변화를 실시간으로 수신합니다.

**Request**
```http
GET /api/auth/stream/{challengeId} HTTP/1.1
Accept: text/event-stream
```

**Events**

#### `snapshot`
초기 연결 시 현재 상태 전송
```json
{
  "type": "snapshot",
  "payload": {
    "challenge_id": "uuid",
    "status": "pending",
    "nonce": "...",
    "expires_at": "..."
  },
  "at": "2024-01-01T12:00:00.000Z"
}
```

#### `approved`
Wallet 승인 완료 (아직 토큰 교환 전)
```json
{
  "type": "approved",
  "payload": {
    "challenge_id": "uuid",
    "status": "approved",
    "authorization_code": "ac_xxx",
    "verified_at": "..."
  },
  "at": "..."
}
```

#### `active`
세션 활성화 완료
```json
{
  "type": "active",
  "payload": {
    "challenge_id": "uuid",
    "status": "active",
    "session_id": "sid_xxx",
    "profile": {
      "subject_id": "sub_xxx",
      "did": "did:miid:xxx",
      "name": "홍길동",
      "email": "user@example.com",
      "nickname": "길동"
    }
  },
  "at": "..."
}
```

#### `denied`
Wallet에서 거부
```json
{
  "type": "denied",
  "payload": {
    "challenge_id": "uuid",
    "status": "denied"
  },
  "at": "..."
}
```

#### `expired`
Challenge 만료
```json
{
  "type": "expired",
  "payload": {
    "challenge_id": "uuid",
    "status": "expired"
  },
  "at": "..."
}
```

#### `error`
처리 중 오류 발생
```json
{
  "type": "error",
  "payload": {
    "challenge_id": "uuid",
    "status": "error",
    "error": "error_message"
  },
  "at": "..."
}
```

---

### 2.3 GET /auth/status/:challengeId

Challenge 현재 상태를 폴링합니다.

**Response (200 OK)**
```json
{
  "challenge_id": "uuid",
  "status": "pending | approved | active | denied | expired | error",
  "authorization_code": "ac_xxx",
  "session_id": "sid_xxx",
  "profile": { ... },
  "updated_at": "..."
}
```

---

### 2.4 POST /auth/complete/:challengeId

Active 상태의 세션을 완료하고 쿠키를 설정합니다.

**Request**
```http
POST /api/auth/complete/{challengeId} HTTP/1.1
Content-Type: application/json

{}
```

**Response (200 OK)**
```http
Set-Cookie: sid=sid_xxx; HttpOnly; SameSite=Lax; Max-Age=3600; Path=/

{
  "status": "active",
  "session_id": "sid_xxx",
  "profile": {
    "subject_id": "sub_xxx",
    "did": "did:miid:xxx",
    "name": "홍길동",
    "email": "user@example.com",
    "nickname": "길동"
  }
}
```

**Error Responses**

| Status | Error Code | 설명 |
|--------|------------|------|
| 404 | `challenge_not_found` | Challenge 없음 |
| 409 | `not_active_yet` | 아직 Active 상태 아님 |

---

### 2.5 GET /profile

현재 세션의 프로필 정보를 조회합니다.

**Request**
```http
GET /api/profile HTTP/1.1
Cookie: sid=sid_xxx
```

**Response (200 OK)**
```json
{
  "subject_id": "sub_xxx",
  "did": "did:miid:xxx",
  "service_id": "service-test",
  "scope": "profile email",
  "requested_claims": ["name", "email", "nickname"],
  "approved_claims": ["name", "email"],
  "risk_level": "normal",
  "name": "홍길동",
  "email": "user@example.com",
  "session_expires_at": "2024-01-01T13:00:00.000Z"
}
```

**응답 필드 설명:**

| Field | 설명 |
|-------|------|
| `requested_claims` | 서비스가 요청한 클레임 목록 (동적으로 설정 가능) |
| `approved_claims` | 사용자가 승인한 클레임 목록 |
| `{claim_name}` | 승인된 각 클레임의 실제 값 (approved_claims에 포함된 항목만) |

**프론트엔드 렌더링:**
- `requested_claims`의 모든 항목을 UI에 표시
- 승인된 클레임은 값 표시, 미승인 클레임은 `-` 표시

**Error Responses**

| Status | Error Code | 설명 |
|--------|------------|------|
| 401 | `not_authenticated` | 세션 없음 |

---

### 2.6 POST /service/manage

서비스 설정을 동적으로 변경합니다. (개발/테스트용)

**Request**
```http
POST /api/service/manage HTTP/1.1
Content-Type: application/json

{
  "service_id": "my-service",
  "service_name": "My Service",
  "requested_fields": "name,email,phone,address"
}
```

**Response (200 OK)**
```json
{
  "success": true,
  "service_id": "my-service",
  "service_name": "My Service",
  "requested_claims": ["name", "email", "phone", "address"]
}
```

**동작 방식**:
1. Gateway에 새 서비스 등록 (`/v1/services`)
2. 로컬 상태 업데이트 (`CURRENT_SERVICE_ID`, `CURRENT_CLIENT_ID`, `DYNAMIC_REQUESTED_CLAIMS`)
3. 이후 로그인 요청은 새 설정으로 수행

**Error Responses**

| Status | Error Code | 설명 |
|--------|------------|------|
| 400 | `invalid_request` | 필수 파라미터 누락 |
| 500 | `management_failed` | 서비스 등록 실패 |

---

### 2.8 POST /logout

세션을 종료합니다.

**Request**
```http
POST /api/logout HTTP/1.1
Cookie: sid=sid_xxx
```

**Response (200 OK)**
```http
Set-Cookie: sid=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/

{
  "success": true,
  "message": "Logged out successfully"
}
```

---

### 2.9 GET /session/stream (SSE)

세션 상태 변화를 실시간으로 수신합니다. (Wallet에서 revoke 감지)

**Request**
```http
GET /api/session/stream HTTP/1.1
Cookie: sid=sid_xxx
Accept: text/event-stream
```

**Events**

#### `connected`
연결 성공
```json
{
  "sid": "sid_xxx",
  "at": "..."
}
```

#### `force_logout`
Wallet에서 세션 revoke
```json
{
  "type": "force_logout",
  "payload": {
    "reason": "revoked",
    "session_id": "gateway_session_id"
  },
  "at": "..."
}
```

---

## 3. Service Backend ↔ Gateway

### 3.1 POST /v1/services

서비스를 동적으로 등록하거나 업데이트합니다.

**Request**
```http
POST /v1/services HTTP/1.1
Content-Type: application/json
X-Client-Id: web-client
X-Client-Secret: dev-service-secret

{
  "client_id": "my-service",
  "service_id": "my-service",
  "client_secret": "my-secret",
  "redirect_uris": ["https://my-service.local/callback"]
}
```

**Response (200 OK)**
```json
{
  "success": true,
  "service": {
    "client_id": "my-service",
    "service_id": "my-service",
    "client_secret": "my-secret",
    "redirect_uris": ["https://my-service.local/callback"],
    "updated_at": "2024-01-01T12:00:00.000Z"
  }
}
```

**동작 방식:**
- 동일한 `client_id`가 존재하면 업데이트
- 존재하지 않으면 새로 등록
- 등록 후 서비스 레지스트리 즉시 리로드

**Error Responses**

| Status | Error Code | 설명 |
|--------|------------|------|
| 400 | `invalid_request` | 필수 파라미터 누락 |
| 401 | `service_client_auth_required` | 인증 헤더 누락 |
| 401 | `invalid_service_client_credentials` | 잘못된 인증 정보 |

---

### 3.2 POST /v1/auth/challenge

새로운 인증 Challenge를 생성합니다.

**Request**
```http
POST /v1/auth/challenge HTTP/1.1
Content-Type: application/json
X-Client-Id: web-client
X-Client-Secret: dev-service-secret
X-Local-Wallet-Ready: 1

{
  "service_id": "service-test",
  "client_id": "web-client",
  "redirect_uri": "https://service-test.local/callback",
  "scopes": ["profile", "email"],
  "requested_claims": ["name", "email", "nickname"],
  "state": "optional_state_string",
  "risk_action": null,
  "did_hint": "did:miid:xxx",
  "require_user_approval": true
}
```

**Response (201 Created)**
```json
{
  "challenge_id": "uuid",
  "nonce": "random_base64url_24bytes",
  "expires_at": "2024-01-01T12:05:00.000Z",
  "status": "pending",
  "requested_claims": ["name", "email", "nickname"]
}
```

**Error Responses**

| Status | Error Code | 설명 |
|--------|------------|------|
| 400 | `invalid_request` | 필수 파라미터 누락 |
| 401 | `service_client_auth_required` | 인증 헤더 누락 |
| 401 | `invalid_service_client_credentials` | 잘못된 인증 정보 |
| 403 | `client_id_mismatch` | client_id 불일치 |
| 403 | `service_id_mismatch` | service_id 불일치 |
| 403 | `redirect_uri_not_allowed` | 허용되지 않은 redirect_uri |
| 409 | `wallet_local_required` | 로컬 월렛 필수 |
| 409 | `wallet_local_unreachable` | 월렛 미연결 |

---

### 3.3 GET /v1/service/events (SSE)

Challenge 관련 이벤트를 수신합니다.

**Request**
```http
GET /v1/service/events?challenge_id={challengeId} HTTP/1.1
X-Client-Id: web-client
X-Client-Secret: dev-service-secret
Accept: text/event-stream
```

**Events**

#### `connected`
```json
{
  "challenge_id": "uuid",
  "at": "..."
}
```

#### `challenge_verified`
Wallet 승인 및 서명 검증 완료
```json
{
  "type": "challenge_verified",
  "payload": {
    "challenge_id": "uuid",
    "authorization_code": "ac_xxx",
    "service_id": "service-test",
    "client_id": "web-client",
    "redirect_uri": "https://...",
    "status": "verified"
  },
  "at": "..."
}
```

#### `challenge_denied`
```json
{
  "type": "challenge_denied",
  "payload": {
    "challenge_id": "uuid",
    "service_id": "service-test"
  },
  "at": "..."
}
```

#### `challenge_expired`
```json
{
  "type": "challenge_expired",
  "payload": {
    "challenge_id": "uuid"
  },
  "at": "..."
}
```

---

### 3.4 GET /v1/service/session-events (SSE)

서비스의 전체 세션 이벤트를 수신합니다.

**Request**
```http
GET /v1/service/session-events HTTP/1.1
X-Client-Id: web-client
X-Client-Secret: dev-service-secret
Accept: text/event-stream
```

**Events**

#### `session_created`
```json
{
  "type": "session_created",
  "payload": {
    "session_id": "uuid",
    "service_id": "service-test",
    "subject_id": "sub_xxx",
    "did": "did:miid:xxx",
    "scope": "profile email",
    "expires_at": "..."
  },
  "at": "..."
}
```

#### `session_revoked`
```json
{
  "type": "session_revoked",
  "payload": {
    "session_id": "uuid",
    "service_id": "service-test",
    "subject_id": "sub_xxx",
    "did": "did:miid:xxx"
  },
  "at": "..."
}
```

---

### 3.5 GET /v1/auth/challenges/:challengeId/status

Challenge 상태를 조회합니다.

**Response (200 OK)**
```json
{
  "challenge_id": "uuid",
  "status": "pending | verified | denied | expired",
  "authorization_code": "ac_xxx",
  "verified_at": "...",
  "denied_at": null,
  "expires_at": "..."
}
```

---

### 3.6 POST /v1/token/exchange

Authorization Code를 Access Token으로 교환합니다.

**Request**
```http
POST /v1/token/exchange HTTP/1.1
Content-Type: application/json
X-Client-Id: web-client
X-Client-Secret: dev-service-secret

{
  "grant_type": "authorization_code",
  "code": "ac_xxx",
  "client_id": "web-client",
  "redirect_uri": "https://service-test.local/callback"
}
```

**Response (200 OK)**
```json
{
  "session_id": "uuid",
  "access_token": "at_xxx",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "rt_xxx",
  "id_token": "id_xxx",
  "scope": "profile email"
}
```

**Error Responses**

| Status | Error Code | 설명 |
|--------|------------|------|
| 400 | `invalid_request` | 필수 파라미터 누락 |
| 400 | `invalid_code` | 유효하지 않은 code |
| 401 | `code_expired` | code 만료 |
| 401 | `client_or_redirect_mismatch` | client/redirect 불일치 |
| 403 | `consent_required` | 동의 필요 |
| 409 | `code_already_used` | 이미 사용된 code |

---

### 3.7 GET /v1/services/:serviceId/profile

Access Token으로 사용자 프로필을 조회합니다.

**Request**
```http
GET /v1/services/{serviceId}/profile HTTP/1.1
Authorization: Bearer at_xxx
```

**Response (200 OK)**
```json
{
  "service_id": "service-test",
  "subject_id": "sub_xxx",
  "did": "did:miid:xxx",
  "scope": "profile email",
  "requested_claims": ["name", "email", "nickname"],
  "approved_claims": ["name", "email"],
  "risk_level": "normal",
  "name": "홍길동",
  "email": "user@example.com",
  "nickname": null
}
```

**Error Responses**

| Status | Error Code | 설명 |
|--------|------------|------|
| 401 | `invalid_token` | 유효하지 않은 토큰 |
| 401 | `token_expired_or_revoked` | 토큰 만료/취소 |
| 403 | `service_mismatch` | 서비스 불일치 |

---

### 3.8 POST /v1/auth/reuse-session

기존 세션 재사용을 시도합니다.

**Request**
```http
POST /v1/auth/reuse-session HTTP/1.1
Content-Type: application/json
X-Client-Id: web-client
X-Client-Secret: dev-service-secret

{
  "did": "did:miid:xxx",
  "scopes": ["profile", "email"]
}
```

**Response (200 OK)**
```json
{
  "reused": true,
  "session_id": "uuid",
  "access_token": "at_xxx",
  "refresh_token": "rt_xxx",
  "scope": "profile email",
  "expires_at": "..."
}
```

**Error Responses**

| Status | Error Code | 설명 |
|--------|------------|------|
| 403 | `wallet_approval_required` | 월렛 승인 필요 |
| 404 | `no_reusable_session` | 재사용 가능한 세션 없음 |

---

### 3.9 POST /v1/wallet/notify-reuse

세션 재사용을 Wallet에 알립니다.

**Request**
```http
POST /v1/wallet/notify-reuse HTTP/1.1
Content-Type: application/json
X-Client-Id: web-client
X-Client-Secret: dev-service-secret

{
  "did": "did:miid:xxx",
  "scopes": ["profile", "email"]
}
```

**Response (200 OK)**
```json
{
  "ok": true
}
```

---

## 4. Gateway ↔ Wallet (SSE)

### 4.1 GET /v1/wallet/events

Wallet이 DID별로 이벤트를 수신합니다.

**Request**
```http
GET /v1/wallet/events?did={did} HTTP/1.1
Accept: text/event-stream
```

**Events**

#### `connected`
```json
{
  "did": "did:miid:xxx",
  "at": "..."
}
```

#### `challenge_created`
새로운 인증 요청 도착
```json
{
  "type": "challenge_created",
  "payload": {
    "challenge_id": "uuid",
    "service_id": "service-test",
    "did_hint": "did:miid:xxx",
    "scopes": ["profile", "email"],
    "requested_claims": ["name", "email", "nickname"],
    "expires_at": "..."
  },
  "at": "..."
}
```

#### `challenge_approved`
본인 승인 완료 확인
```json
{
  "type": "challenge_approved",
  "payload": {
    "challenge_id": "uuid",
    "authorization_code": "ac_xxx",
    "service_id": "service-test"
  },
  "at": "..."
}
```

#### `challenge_denied`
본인 거부 확인
```json
{
  "type": "challenge_denied",
  "payload": {
    "challenge_id": "uuid",
    "service_id": "service-test"
  },
  "at": "..."
}
```

#### `challenge_expired`
Challenge 만료
```json
{
  "type": "challenge_expired",
  "payload": {
    "challenge_id": "uuid"
  },
  "at": "..."
}
```

#### `session_created`
새 세션 생성됨
```json
{
  "type": "session_created",
  "payload": {
    "session_id": "uuid",
    "service_id": "service-test",
    "scope": "profile email",
    "expires_at": "..."
  },
  "at": "..."
}
```

#### `session_revoked`
세션 취소됨
```json
{
  "type": "session_revoked",
  "payload": {
    "session_id": "uuid",
    "service_id": "service-test"
  },
  "at": "..."
}
```

#### `approved_cancelled`
승인 취소됨 (세션 생성 전)
```json
{
  "type": "approved_cancelled",
  "payload": {
    "challenge_id": "uuid",
    "authorization_code": "ac_xxx",
    "service_id": "service-test"
  },
  "at": "..."
}
```

#### `login_reused`
세션 재사용 로그인 알림
```json
{
  "type": "login_reused",
  "payload": {
    "service_id": "service-test",
    "scopes": ["profile", "email"],
    "reused": true
  },
  "at": "..."
}
```

---

## 5. Wallet → Gateway (API)

### 5.1 GET /v1/wallet/challenges

DID의 pending challenge 목록을 조회합니다.

**Request**
```http
GET /v1/wallet/challenges?did={did} HTTP/1.1
```

**Response (200 OK)**
```json
{
  "did": "did:miid:xxx",
  "challenges": [
    {
      "challenge_id": "uuid",
      "service_id": "service-test",
      "client_id": "web-client",
      "nonce": "...",
      "scopes": ["profile", "email"],
      "did_hint": "did:miid:xxx",
      "requested_claims": ["name", "email", "nickname"],
      "risk_action": null,
      "expires_at": "..."
    }
  ]
}
```

---

### 5.2 POST /v1/wallet/challenges/:challengeId/approve

Challenge를 승인합니다.

**Request**
```http
POST /v1/wallet/challenges/{challengeId}/approve HTTP/1.1
Content-Type: application/json

{
  "did": "did:miid:xxx",
  "signature": "base64url_ed25519_signature",
  "wallet_url": "http://localhost:17000",
  "approved_claims": ["name", "email"]
}
```

**Signature Payload** (JSON stringified)
```json
{
  "challenge_id": "uuid",
  "nonce": "...",
  "audience": "web-client",
  "expires_at": "..."
}
```

**Response (200 OK)**
```json
{
  "challenge_id": "uuid",
  "status": "verified",
  "authorization_code": "ac_xxx",
  "subject_id": "sub_xxx",
  "consent_required": false,
  "missing_scopes": [],
  "approved_claims": ["name", "email"]
}
```

**Error Responses**

| Status | Error Code | 설명 |
|--------|------------|------|
| 400 | `invalid_request` | 필수 파라미터 누락 |
| 401 | `invalid_signature` | 서명 검증 실패 |
| 401 | `challenge_expired` | Challenge 만료 |
| 403 | `did_mismatch` | DID 불일치 |
| 404 | `challenge_not_found` | Challenge 없음 |
| 409 | `challenge_not_pending` | Pending 상태 아님 |

---

### 5.3 POST /v1/wallet/challenges/:challengeId/deny

Challenge를 거부합니다.

**Request**
```http
POST /v1/wallet/challenges/{challengeId}/deny HTTP/1.1
Content-Type: application/json

{
  "did": "did:miid:xxx"
}
```

**Response (200 OK)**
```json
{
  "challenge_id": "uuid",
  "status": "denied",
  "denied_at": "..."
}
```

---

### 5.4 GET /v1/wallet/sessions

DID의 active 세션 목록을 조회합니다.

**Request**
```http
GET /v1/wallet/sessions?did={did} HTTP/1.1
```

**Response (200 OK)**
```json
{
  "did": "did:miid:xxx",
  "sessions": [
    {
      "session_id": "uuid",
      "service_id": "service-test",
      "subject_id": "sub_xxx",
      "scope": "profile email",
      "requested_claims": ["name", "email", "nickname"],
      "approved_claims": ["name", "email"],
      "risk_level": "normal",
      "expires_at": "...",
      "created_at": "..."
    }
  ]
}
```

---

### 5.5 DELETE /v1/wallet/sessions/:sessionId

세션을 revoke합니다.

**Request**
```http
DELETE /v1/wallet/sessions/{sessionId} HTTP/1.1
Content-Type: application/json

{
  "did": "did:miid:xxx"
}
```

**Response (200 OK)**
```json
{
  "session_id": "uuid",
  "status": "revoked",
  "revoked_at": "..."
}
```

---

### 5.6 GET /v1/wallet/approved

DID의 승인 완료 대기 중인 authorization code 목록을 조회합니다.

**Request**
```http
GET /v1/wallet/approved?did={did} HTTP/1.1
```

**Response (200 OK)**
```json
{
  "did": "did:miid:xxx",
  "approved": [
    {
      "authorization_code": "ac_xxx",
      "challenge_id": "uuid",
      "service_id": "service-test",
      "client_id": "web-client",
      "redirect_uri": "https://...",
      "subject_id": "sub_xxx",
      "scopes": ["profile", "email"],
      "requested_claims": ["name", "email", "nickname"],
      "approved_claims": ["name", "email"],
      "expires_at": "..."
    }
  ]
}
```

---

### 5.7 DELETE /v1/wallet/approved/:authCode

승인을 취소하고 Challenge를 pending 상태로 되돌립니다.

**Request**
```http
DELETE /v1/wallet/approved/{authCode} HTTP/1.1
Content-Type: application/json

{
  "did": "did:miid:xxx"
}
```

**Response (200 OK)**
```json
{
  "challenge_id": "uuid",
  "authorization_code": "ac_xxx",
  "status": "pending",
  "restored_at": "..."
}
```

---

## 6. Gateway/Wallet App → Wallet Server

### 6.1 POST /v1/wallets

새 Wallet을 생성합니다.

**Request**
```http
POST /v1/wallets HTTP/1.1
Content-Type: application/json

{
  "name": "홍길동",
  "email": "user@example.com",
  "nickname": "길동"
}
```

**Response (201 Created)**
```json
{
  "wallet_id": "uuid",
  "did": "did:miid:uuid",
  "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "name": "홍길동",
  "email": "user@example.com",
  "nickname": "길동"
}
```

---

### 6.2 GET /v1/wallets

전체 Wallet 목록을 조회합니다.

**Response (200 OK)**
```json
{
  "wallets": [
    {
      "wallet_id": "uuid",
      "did": "did:miid:uuid",
      "name": "홍길동",
      "email": "user@example.com",
      "nickname": "길동",
      "created_at": "...",
      "custom_fields": {
        "company": {
          "label": "회사",
          "key": "company",
          "value": "ACME Inc."
        }
      }
    }
  ]
}
```

---

### 6.3 GET /v1/wallets/:walletId

Wallet 상세 정보를 조회합니다.

**Response (200 OK)**
```json
{
  "wallet_id": "uuid",
  "did": "did:miid:uuid",
  "name": "홍길동",
  "email": "user@example.com",
  "nickname": "길동",
  "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
}
```

---

### 6.4 GET /v1/wallets/by-did/:did

DID로 Wallet을 조회합니다. (Gateway DID Resolution에 사용)

**Response (200 OK)**
```json
{
  "wallet_id": "uuid",
  "did": "did:miid:uuid",
  "kid": "did:miid:uuid#key-1",
  "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "name": "홍길동",
  "email": "user@example.com",
  "nickname": "길동",
  "custom_fields": {}
}
```

---

### 6.5 PUT /v1/wallets/by-did/:did/profile

Wallet 프로필을 업데이트합니다.

**Request**
```http
PUT /v1/wallets/by-did/{did}/profile HTTP/1.1
Content-Type: application/json

{
  "name": "홍길동",
  "email": "new@example.com",
  "nickname": "길동이",
  "custom_fields": {
    "company": {
      "label": "회사",
      "key": "company",
      "value": "NewCorp"
    },
    "school": {
      "label": "학교",
      "key": "school",
      "value": "서울대학교"
    }
  }
}
```

**Response (200 OK)**
```json
{
  "wallet_id": "uuid",
  "did": "did:miid:uuid",
  "name": "홍길동",
  "email": "new@example.com",
  "nickname": "길동이",
  "custom_fields": {
    "company": {
      "label": "회사",
      "key": "company",
      "value": "NewCorp"
    },
    "school": {
      "label": "학교",
      "key": "school",
      "value": "서울대학교"
    }
  },
  "updated_at": "..."
}
```

---

### 6.6 POST /v1/wallets/sign

Challenge payload에 서명합니다.

**Request**
```http
POST /v1/wallets/sign HTTP/1.1
Content-Type: application/json
X-Wallet-Sign-Secret: {secret}

{
  "did": "did:miid:xxx",
  "challenge_id": "uuid",
  "nonce": "...",
  "audience": "web-client",
  "expires_at": "..."
}
```

**Response (200 OK)**
```json
{
  "did": "did:miid:xxx",
  "kid": "did:miid:xxx#key-1",
  "signature": "base64url_ed25519_signature",
  "signed_payload": {
    "challenge_id": "uuid",
    "nonce": "...",
    "audience": "web-client",
    "expires_at": "..."
  }
}
```

**Error Responses**

| Status | Error Code | 설명 |
|--------|------------|------|
| 400 | `invalid_request` | 필수 파라미터 누락 |
| 401 | `unauthorized_sign_request` | 서명 시크릿 불일치 |
| 404 | `wallet_not_found` | Wallet 없음 |

---

### 6.7 DELETE /v1/wallets/by-did/:did

Wallet을 삭제합니다.

**Response (200 OK)**
```json
{
  "deleted": true,
  "did": "did:miid:xxx",
  "wallet_id": "uuid"
}
```

---

### 6.8 GET /health

서버 상태를 확인합니다.

**Response (200 OK)**
```json
{
  "ok": true,
  "service": "wallet",
  "now": "2024-01-01T12:00:00.000Z"
}
```

---

## 7. 공통 규격

### 7.1 DID Format

```
did:miid:{wallet_id}
```

- `wallet_id`: UUID v4 format

### 7.2 Key ID (kid) Format

```
{did}#key-1
```

예: `did:miid:550e8400-e29b-41d4-a716-446655440000#key-1`

### 7.3 Signature Algorithm

- **Algorithm**: Ed25519
- **Key Format**: SPKI (public), PKCS8 (private), PEM encoded
- **Signature Encoding**: Base64URL

### 7.4 Signature Payload Format

Challenge 서명 시 사용하는 payload:

```json
{
  "challenge_id": "uuid",
  "nonce": "random_base64url_string",
  "audience": "client_id",
  "expires_at": "ISO8601_timestamp"
}
```

JSON.stringify() 후 UTF-8 bytes로 서명

### 7.5 Token Formats

| Token Type | Prefix | Length |
|------------|--------|--------|
| Authorization Code | `ac_` | 24 bytes base64url |
| Access Token | `at_` | 24 bytes base64url |
| Refresh Token | `rt_` | 24 bytes base64url |
| ID Token | `id_` | 24 bytes base64url |
| Session ID | `sid_` | 24 bytes base64url |
| Subject ID | `sub_` | UUID without dashes |

### 7.6 Timestamp Format

- ISO 8601 format
- UTC timezone
- 예: `2024-01-01T12:00:00.000Z`

### 7.7 TTL (Time-To-Live)

| Item | TTL |
|------|-----|
| Challenge | 5분 |
| Authorization Code | 2분 |
| Access Token (normal) | 60분 |
| Access Token (step_up) | 10분 |
| Session | 설정 가능 (기본 60분) |

### 7.8 Scopes

현재 지원되는 scope:

| Scope | 설명 |
|-------|------|
| `profile` | 기본 프로필 (name, nickname) |
| `email` | 이메일 주소 |

### 7.9 Claims

요청 가능한 claim:

| Claim | 설명 | Scope 연관 |
|-------|------|-----------|
| `name` | 실명 | profile |
| `nickname` | 닉네임 | profile |
| `email` | 이메일 | email |
| (custom) | 사용자 정의 필드 | - |

### 7.10 Status Values

#### Challenge Status
| Status | 설명 |
|--------|------|
| `pending` | 대기 중 |
| `verified` | 서명 검증 완료 |
| `denied` | 사용자 거부 |
| `expired` | 만료됨 |

#### Session Status
| Status | 설명 |
|--------|------|
| `active` | 활성 |
| `revoked` | 취소됨 |
| `expired` | 만료됨 |

#### Consent Status
| Status | 설명 |
|--------|------|
| `active` | 활성 |
| `revoked` | 취소됨 |

### 7.11 Risk Levels

| Level | 설명 | Token TTL |
|-------|------|-----------|
| `normal` | 일반 | 60분 |
| `step_up` | 강화 인증 | 10분 |

---

## Appendix: Error Code Reference

| Error Code | HTTP Status | 설명 |
|------------|-------------|------|
| `invalid_request` | 400 | 잘못된 요청 |
| `service_client_auth_required` | 401 | 서비스 클라이언트 인증 필요 |
| `invalid_service_client_credentials` | 401 | 잘못된 서비스 클라이언트 자격증명 |
| `missing_bearer_token` | 401 | Bearer 토큰 누락 |
| `invalid_token` | 401 | 유효하지 않은 토큰 |
| `invalid_signature` | 401 | 서명 검증 실패 |
| `unauthorized_sign_request` | 401 | 서명 요청 권한 없음 |
| `challenge_expired` | 401 | Challenge 만료 |
| `code_expired` | 401 | Authorization code 만료 |
| `token_expired_or_revoked` | 401 | 토큰 만료/취소됨 |
| `client_or_redirect_mismatch` | 401 | 클라이언트/리다이렉트 불일치 |
| `did_mismatch` | 403 | DID 불일치 |
| `client_id_mismatch` | 403 | Client ID 불일치 |
| `service_id_mismatch` | 403 | Service ID 불일치 |
| `redirect_uri_not_allowed` | 403 | 허용되지 않은 redirect URI |
| `service_mismatch` | 403 | 서비스 불일치 |
| `consent_required` | 403 | 동의 필요 |
| `user_approval_required` | 403 | 사용자 승인 필요 |
| `wallet_approval_required` | 403 | 월렛 승인 필요 |
| `challenge_not_found` | 404 | Challenge 없음 |
| `session_not_found` | 404 | 세션 없음 |
| `wallet_not_found` | 404 | Wallet 없음 |
| `did_not_found` | 404 | DID 없음 |
| `auth_code_not_found` | 404 | Authorization code 없음 |
| `consent_not_found` | 404 | Consent 없음 |
| `no_reusable_session` | 404 | 재사용 가능한 세션 없음 |
| `challenge_already_used` | 409 | Challenge 이미 사용됨 |
| `challenge_not_pending` | 409 | Challenge가 pending 상태 아님 |
| `code_already_used` | 409 | Code 이미 사용됨 |
| `already_exchanged` | 409 | 이미 교환됨 |
| `already_revoked` | 409 | 이미 취소됨 |
| `challenge_expired_cannot_restore` | 409 | 만료되어 복원 불가 |
| `wallet_local_required` | 409 | 로컬 월렛 필요 |
| `wallet_local_unreachable` | 409 | 로컬 월렛 연결 불가 |
| `not_active_yet` | 409 | 아직 활성화되지 않음 |
| `verify_failed` | 500 | 검증 실패 |
| `approve_failed` | 500 | 승인 실패 |
| `auth_start_failed` | 500 | 인증 시작 실패 |
