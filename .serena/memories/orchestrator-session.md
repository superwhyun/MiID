# Orchestrator Session
## ID: session-20260215-150652
## Started: 2026-02-15T06:06:52.970Z
## Status: idle

## Agents
| Agent ID | CLI | PID | Status | Task |
|----------|-----|-----|--------|------|

## Summary (filled on completion)
- Total Tasks: 0
- Completed: 0
- Failed: 0
- Files Created: []
- Issues: []

## DID 로그인 보안 체크리스트
- [ ] **리플레이 공격 방지 (Replay Attack Prevention)**: 모든 요청에 고유한 nonce를 사용하고 서버에서 중복 사용 여부를 검증하는가?
- [ ] **Nonce TTL 설정**: nonce의 유효 기간(Time-To-Live)이 짧게 설정되어 있으며, 만료된 nonce는 거부되는가?
- [ ] **Audience 바인딩**: ID 토큰이나 VC의 `aud` 필드가 현재 요청하는 서비스의 Client ID와 일치하는지 검증하는가?
- [ ] **키 회전 (Key Rotation)**: DID Document의 공개키가 정기적으로 회전되거나 보안 사고 시 즉각 교체 가능한 프로세스가 있는가?
- [ ] **VC 폐기 확인 (VC Revocation Check)**: 검증 시점에 해당 VC가 폐기되었는지 여부를 CRL이나 OCSP, 또는 폐기 레지스트리를 통해 확인하는가?
- [ ] **동의 감사로그 (Consent Audit Logs)**: 사용자의 개인정보 제공 동의 내역이 위변조 불가능한 형태로 기록되고 관리되는가?

## 보안 체크리스트
- [ ] **리플레이 (Replay)**: 재사용 공격 방지를 위한 Nonce 검증 및 처리
- [ ] **Nonce TTL**: Nonce의 유효 시간(Time-To-Live) 제한 및 관리
- [ ] **Audience**: 토큰의 수신처(Audience)가 의도한 대상과 일치하는지 확인
- [ ] **키회전 (Key Rotation)**: 정기적/비정기적 암호화 키 교체 프로세스
- [ ] **Revoke**: 유효하지 않은 권한이나 토큰의 즉시 폐기 및 차단
- [ ] **감사로그 (Audit Logs)**: 보안 관련 주요 행위에 대한 추적 가능한 로그 기록

---

## 관리형 DID Auth Gateway API 제안서

### 개요
이 제안서는 사용자가 직접 DID 키를 관리하지 않고, 서비스 제공자가 DID 인증 과정을 대신 처리해주는 관리형(Custodial) DID Auth Gateway의 API 설계와 데이터베이스 스키마를 정의합니다.

### API 엔드포인트

#### 1. POST /auth/challenge
**목적**: 인증 시작 - 클라이언트가 DID 인증을 시작하기 위한 챌린지를 요청

**요청 (Request)**:
```json
{
  "service_id": "service-123",
  "client_id": "client-app-xyz",
  "redirect_uri": "https://example.com/callback",
  "scope": ["profile", "email"],
  "state": "random-state-string"
}
```

**응답 (Response)**:
```json
{
  "challenge_id": "chal_abc123",
  "challenge": "random-nonce-string",
  "expires_at": "2026-02-15T07:00:00Z",
  "qr_code": "data:image/png;base64,..."
}
```

**설명**:
- `challenge_id`: 챌린지의 고유 식별자
- `challenge`: 서명에 사용될 nonce 값 (리플레이 공격 방지)
- `expires_at`: 챌린지 만료 시간 (TTL)
- `qr_code`: 모바일 앱에서 스캔할 수 있는 QR 코드 (옵션)

---

#### 2. POST /auth/verify
**목적**: 인증 검증 - 사용자가 제출한 서명 또는 VP를 검증

**요청 (Request)**:
```json
{
  "challenge_id": "chal_abc123",
  "did": "did:example:user123",
  "vp": {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    "type": ["VerifiablePresentation"],
    "verifiableCredential": [...],
    "proof": {
      "type": "Ed25519Signature2020",
      "created": "2026-02-15T06:30:00Z",
      "proofPurpose": "authentication",
      "verificationMethod": "did:example:user123#key-1",
      "jws": "eyJhbGc..."
    }
  }
}
```

**응답 (Response)**:
```json
{
  "status": "verified",
  "auth_code": "auth_xyz789",
  "redirect_uri": "https://example.com/callback?code=auth_xyz789&state=random-state-string"
}
```

**설명**:
- 챌린지 유효성 검증 (TTL, 중복 사용 여부)
- DID Document 조회 및 서명 검증
- VC의 폐기 여부 확인 (Revocation Check)
- Audience 바인딩 검증
- 성공 시 `auth_code` 발급

---

#### 3. POST /token/exchange
**목적**: 토큰 교환 - auth_code를 액세스 토큰으로 교환

**요청 (Request)**:
```json
{
  "grant_type": "authorization_code",
  "code": "auth_xyz789",
  "client_id": "client-app-xyz",
  "client_secret": "secret-key",
  "redirect_uri": "https://example.com/callback"
}
```

**응답 (Response)**:
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "refresh_abc123",
  "id_token": "eyJhbGciOiJSUzI1NiIs...",
  "scope": "profile email"
}
```

**설명**:
- OAuth 2.0 표준 토큰 교환 플로우
- `id_token`: 사용자 신원 정보 (OpenID Connect)
- `access_token`: API 접근용 토큰
- `refresh_token`: 토큰 갱신용

---

#### 4. POST /consents
**목적**: 사용자 동의 기록 및 관리

**요청 (Request)**:
```json
{
  "user_did": "did:example:user123",
  "service_id": "service-123",
  "consented_scopes": ["profile", "email"],
  "consent_type": "explicit",
  "purpose": "서비스 로그인 및 개인정보 제공"
}
```

**응답 (Response)**:
```json
{
  "consent_id": "consent_def456",
  "status": "active",
  "created_at": "2026-02-15T06:45:00Z",
  "audit_hash": "sha256:abc123..."
}
```

**설명**:
- 사용자의 개인정보 제공 동의를 기록
- `audit_hash`: 위변조 방지를 위한 해시 값
- GDPR 등 개인정보 보호 규정 준수

---

#### 5. GET /consents/:consent_id
**목적**: 동의 내역 조회

**응답 (Response)**:
```json
{
  "consent_id": "consent_def456",
  "user_did": "did:example:user123",
  "service_id": "service-123",
  "consented_scopes": ["profile", "email"],
  "status": "active",
  "created_at": "2026-02-15T06:45:00Z",
  "updated_at": "2026-02-15T06:45:00Z",
  "audit_hash": "sha256:abc123..."
}
```

---

#### 6. DELETE /consents/:consent_id
**목적**: 사용자 동의 철회

**응답 (Response)**:
```json
{
  "consent_id": "consent_def456",
  "status": "revoked",
  "revoked_at": "2026-02-15T07:00:00Z"
}
```

---

## 데이터베이스 스키마

### 1. users 테이블
사용자의 기본 정보를 저장하는 테이블

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE,
    phone_number VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) DEFAULT 'active', -- active, suspended, deleted
    metadata JSONB -- 추가 사용자 메타데이터
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);
```

---

### 2. did_identities 테이블
사용자의 DID 정보를 저장하는 테이블

```sql
CREATE TABLE did_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    did VARCHAR(255) UNIQUE NOT NULL,
    did_document JSONB NOT NULL, -- DID Document 전체
    key_type VARCHAR(50) NOT NULL, -- Ed25519, secp256k1, RSA 등
    public_key TEXT NOT NULL,
    private_key_encrypted TEXT, -- 관리형인 경우에만 암호화되어 저장
    verification_method_id VARCHAR(255), -- did:example:user123#key-1
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_rotated_at TIMESTAMP WITH TIME ZONE, -- 키 회전 시점
    is_primary BOOLEAN DEFAULT false, -- 기본 DID 여부
    status VARCHAR(20) DEFAULT 'active', -- active, revoked, suspended
    CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_did_identities_user_id ON did_identities(user_id);
CREATE INDEX idx_did_identities_did ON did_identities(did);
CREATE INDEX idx_did_identities_status ON did_identities(status);
```

---

### 3. service_subjects 테이블
특정 서비스에 대한 사용자의 pairwise 식별자 (서비스별 고유 ID)

```sql
CREATE TABLE service_subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id VARCHAR(255) NOT NULL, -- 서비스의 고유 식별자
    subject_id VARCHAR(255) NOT NULL, -- 서비스별 사용자 고유 ID (pairwise)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(service_id, subject_id),
    CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_service_subjects_user_id ON service_subjects(user_id);
CREATE INDEX idx_service_subjects_service_id ON service_subjects(service_id);
```

**설명**:
- 동일한 사용자가 서비스마다 다른 식별자를 사용 (프라이버시 보호)
- 서비스 간 사용자 추적 방지

---

### 4. consents 테이블
사용자의 개인정보 제공 동의 내역

```sql
CREATE TABLE consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consent_id VARCHAR(255) UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id VARCHAR(255) NOT NULL,
    consented_scopes JSONB NOT NULL, -- ["profile", "email", "phone"]
    consent_type VARCHAR(50) NOT NULL, -- explicit, implicit
    purpose TEXT, -- 동의 목적
    status VARCHAR(20) DEFAULT 'active', -- active, revoked
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP WITH TIME ZONE,
    audit_hash VARCHAR(255) NOT NULL, -- 위변조 방지 해시
    CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_consents_user_id ON consents(user_id);
CREATE INDEX idx_consents_service_id ON consents(service_id);
CREATE INDEX idx_consents_status ON consents(status);
CREATE INDEX idx_consents_consent_id ON consents(consent_id);
```

---

### 5. sessions 테이블
인증 세션 및 토큰 정보

```sql
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(255) UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id VARCHAR(255) NOT NULL,
    auth_code VARCHAR(255) UNIQUE, -- 인증 코드
    access_token VARCHAR(500) UNIQUE, -- 액세스 토큰
    refresh_token VARCHAR(500) UNIQUE, -- 리프레시 토큰
    id_token TEXT, -- ID 토큰 (OpenID Connect)
    challenge_id VARCHAR(255), -- 연결된 챌린지 ID
    nonce VARCHAR(255), -- 리플레이 공격 방지용 nonce
    scope JSONB, -- 요청된 scope
    status VARCHAR(20) DEFAULT 'active', -- active, expired, revoked
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_accessed_at TIMESTAMP WITH TIME ZONE,
    ip_address VARCHAR(45), -- IPv4/IPv6
    user_agent TEXT,
    CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_session_id ON sessions(session_id);
CREATE INDEX idx_sessions_auth_code ON sessions(auth_code);
CREATE INDEX idx_sessions_access_token ON sessions(access_token);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
```

---

### 6. challenges 테이블
인증 챌린지 정보

```sql
CREATE TABLE challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    challenge_id VARCHAR(255) UNIQUE NOT NULL,
    service_id VARCHAR(255) NOT NULL,
    client_id VARCHAR(255) NOT NULL,
    challenge VARCHAR(255) UNIQUE NOT NULL, -- nonce 값
    redirect_uri TEXT NOT NULL,
    scope JSONB,
    state VARCHAR(255), -- CSRF 방지용 state
    status VARCHAR(20) DEFAULT 'pending', -- pending, used, expired
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    ip_address VARCHAR(45),
    user_agent TEXT
);

CREATE INDEX idx_challenges_challenge_id ON challenges(challenge_id);
CREATE INDEX idx_challenges_challenge ON challenges(challenge);
CREATE INDEX idx_challenges_status ON challenges(status);
CREATE INDEX idx_challenges_expires_at ON challenges(expires_at);
```

---

### 7. audit_logs 테이블
보안 감사 로그

```sql
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type VARCHAR(100) NOT NULL, -- login, consent_given, consent_revoked, token_issued, etc.
    resource_type VARCHAR(50), -- session, consent, challenge, etc.
    resource_id VARCHAR(255),
    action VARCHAR(50) NOT NULL, -- create, update, delete, verify
    status VARCHAR(20), -- success, failure
    ip_address VARCHAR(45),
    user_agent TEXT,
    metadata JSONB, -- 추가 컨텍스트 정보
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_event_type ON audit_logs(event_type);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_resource_type ON audit_logs(resource_type);
```

---

### 8. revocation_registry 테이블
VC 및 토큰 폐기 레지스트리

```sql
CREATE TABLE revocation_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credential_id VARCHAR(255) UNIQUE NOT NULL, -- VC ID 또는 토큰 ID
    credential_type VARCHAR(50) NOT NULL, -- vc, access_token, refresh_token
    issuer_did VARCHAR(255),
    subject_did VARCHAR(255),
    revoked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    revocation_reason TEXT,
    revoked_by UUID REFERENCES users(id) ON DELETE SET NULL,
    metadata JSONB
);

CREATE INDEX idx_revocation_credential_id ON revocation_registry(credential_id);
CREATE INDEX idx_revocation_subject_did ON revocation_registry(subject_did);
CREATE INDEX idx_revocation_revoked_at ON revocation_registry(revoked_at);
```

---

## 보안 고려사항

### 1. 리플레이 공격 방지
- `challenges` 테이블에서 nonce 중복 사용 여부 확인
- 사용된 챌린지는 `status`를 `used`로 변경
- TTL 만료된 챌린지는 자동으로 거부

### 2. Nonce TTL 관리
- `challenges.expires_at`을 기준으로 만료 체크
- 주기적인 배치 작업으로 만료된 챌린지 정리

### 3. Audience 바인딩
- VP 검증 시 `aud` 필드가 `service_id` 또는 `client_id`와 일치하는지 확인

### 4. 키 회전 (Key Rotation)
- `did_identities.last_rotated_at`을 기준으로 정기적인 키 회전 스케줄링
- 새 키 생성 시 기존 키는 일정 기간 유지 (그레이스 피리어드)

### 5. VC 폐기 확인
- `/auth/verify` 시점에 `revocation_registry` 테이블 조회
- 폐기된 VC는 즉시 거부

### 6. 동의 감사로그
- `consents` 테이블의 `audit_hash`로 위변조 방지
- 모든 동의 관련 작업은 `audit_logs`에 기록

### 7. 토큰 관리
- `sessions` 테이블에서 토큰 상태 관리
- 만료된 토큰은 자동으로 `status`를 `expired`로 변경
- 의심스러운 활동 감지 시 즉시 `revoked` 처리

---

## 데이터 흐름 예시

### 인증 플로우
1. 클라이언트 → `POST /auth/challenge` → 챌린지 생성 (`challenges` 테이블)
2. 사용자가 VP 생성 및 서명
3. 클라이언트 → `POST /auth/verify` → VP 검증 및 auth_code 발급 (`sessions` 테이블)
4. 클라이언트 → `POST /token/exchange` → 토큰 발급 (`sessions` 업데이트)
5. 동의 기록 → `POST /consents` → `consents` 테이블에 저장
6. 모든 작업 → `audit_logs`에 기록

---

## 마이그레이션 전략

### 초기 설정
```sql
-- 1. 테이블 생성 순서 (외래키 의존성 고려)
CREATE TABLE users;
CREATE TABLE did_identities;
CREATE TABLE service_subjects;
CREATE TABLE consents;
CREATE TABLE sessions;
CREATE TABLE challenges;
CREATE TABLE audit_logs;
CREATE TABLE revocation_registry;

-- 2. 인덱스 생성

-- 3. 초기 데이터 삽입 (필요시)
```

### 데이터 정리 작업
```sql
-- 만료된 챌린지 정리 (매일 실행)
DELETE FROM challenges
WHERE status = 'expired'
AND expires_at < NOW() - INTERVAL '7 days';

-- 만료된 세션 정리
UPDATE sessions
SET status = 'expired'
WHERE expires_at < NOW()
AND status = 'active';

-- 오래된 감사로그 아카이빙 (90일 이상)
-- 실제 운영에서는 별도 아카이브 테이블로 이동
```

---

## 성능 최적화

### 인덱스 전략
- 자주 조회되는 컬럼에 인덱스 생성 (did, email, session_id 등)
- 복합 인덱스 고려 (`user_id`, `service_id`)

### 파티셔닝
- `audit_logs`: 날짜 기반 파티셔닝
- `sessions`: 만료 시간 기반 파티셔닝

### 캐싱
- DID Document는 Redis에 캐싱
- 자주 조회되는 사용자 정보 캐싱

---

## 규정 준수

### GDPR
- 사용자의 모든 데이터는 `users.id`로 연결
- 삭제 요청 시 CASCADE로 연관 데이터 자동 삭제
- `consents` 테이블로 명시적 동의 관리

### 개인정보 보호
- 민감 정보는 암호화 저장 (`private_key_encrypted`)
- 서비스별 pairwise 식별자 사용 (`service_subjects`)
- 모든 접근 기록을 `audit_logs`에 저장

---

## 향후 확장 가능성

### 1. 멀티 DID 지원
- 사용자가 여러 DID를 소유 가능 (`did_identities.is_primary`)

### 2. Federation 지원
- 다른 DID Auth Gateway와 연동

### 3. 분산 저장소 연동
- DID Document를 IPFS나 블록체인에 저장

### 4. 고급 동의 관리
- 세분화된 scope 관리
- 시간 제한 동의 (temporal consent)

---

## 참고 자료
- [W3C DID Core Specification](https://www.w3.org/TR/did-core/)
- [W3C Verifiable Credentials](https://www.w3.org/TR/vc-data-model/)
- [OAuth 2.0 RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749)
- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)
