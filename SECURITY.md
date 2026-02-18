# MiID Security Review

이 문서는 MiID 분산 신원 인증 시스템의 보안 검토 결과를 기록합니다.

## 목차

1. [DID 철학 반영 평가](#1-did-철학-반영-평가)
2. [프로토콜/아키텍처 보안 문제점](#2-프로토콜아키텍처-보안-문제점)
3. [설계 수준 권장사항](#3-설계-수준-권장사항)
4. [요약 및 로드맵](#4-요약-및-로드맵)

---

## 1. DID 철학 반영 평가

### 1.1 잘 반영된 부분

| 원칙 | 구현 상태 | 설명 |
|------|-----------|------|
| **자기주권 (Self-Sovereign)** | ✅ 양호 | 키 생성/보관이 Wallet 로컬에서 수행 (Ed25519) |
| **사용자 통제** | ✅ 양호 | 사용자가 승인/거부 의사결정, claims 선택적 공개 |
| **최소 정보 원칙** | ✅ 양호 | `approved_claims`로 필요한 정보만 선택적 공개 |
| **세션 철회** | ✅ 양호 | 사용자가 언제든 활성 세션을 revoke 가능 |
| **로컬 키 보관** | ✅ 양호 | 개인키는 Wallet 로컬에만 저장, 외부 전송 없음 |

### 1.2 DID 철학과 충돌하는 설계

#### 1.2.1 DID 분산성 부재

**현재 구현**:
```
did:miid:{wallet_id}  →  단순 UUID 기반, 분산 원장 없음
```

**문제점**:
- `did:miid`는 로컬 Wallet Server에 완전 의존
- Gateway가 `wallet_url`로 DID Document를 직접 fetch해야 함
- 외부 검증자가 독립적으로 DID를 해석할 수 없음

**DID 철학 위배**:
- W3C DID 표준에 따르면 DID는 중앙 기관 없이 독립적으로 검증 가능해야 함
- 현재 구조에서는 Wallet Server 가용성에 전적으로 의존

**관련 코드**: `apps/gateway/server.js:306-321`
```javascript
async function resolveDidDocument({ did, walletUrl }) {
  if (did.startsWith("did:miid:")) {
    if (!walletUrl) {
      throw new Error("wallet_url_required_for_did_miid");
    }
    const wallet = await fetchWalletByDid(walletUrl, did);
    return {
      didDocument: buildDidDocumentFromWalletRecord(wallet),
      wallet
    };
  }
  throw new Error(`unsupported_did_method:${did.split(":")[1] || "unknown"}`);
}
```

#### 1.2.2 Gateway 중앙 집중

**현재 구현**:
- Challenge 생성/관리: Gateway
- Session 상태 관리: Gateway
- Token 발급/검증: Gateway
- Consent 저장: Gateway

**문제점**:
- Gateway가 단일 장애점(SPOF)이자 신뢰 앵커 역할
- Gateway가 compromised되면 전체 시스템 위험
- DID 철학상 검증은 분산되어야 함

---

## 2. 프로토콜/아키텍처 보안 문제점

### 2.1 심각 (High Severity)

#### 2.1.1 DID Resolution 신뢰 문제

**위치**: `apps/gateway/server.js:306-321`

**취약점 설명**:
Wallet이 승인 요청 시 `wallet_url`을 직접 제공하며, Gateway는 이 URL로 DID Document를 조회합니다.

```javascript
// 공격 시나리오
POST /v1/wallet/challenges/:id/approve
{
  "did": "did:miid:victim-uuid",
  "signature": "attacker_signature",
  "wallet_url": "https://attacker-controlled-server.com"  // 악의적 서버
}
```

**공격 시나리오**:
1. 공격자가 악의적 Wallet Server를 운영
2. 피해자의 DID로 승인 요청 전송
3. `wallet_url`에 자신의 서버 주소 제공
4. 공격자 서버가 가짜 공개키(공격자 소유) 반환
5. 공격자 개인키로 서명하면 검증 통과
6. **결과: 타인 신원 사칭 성공**

**영향도**:
- 완전한 신원 도용 가능
- 인증 시스템 우회
- 피해자 계정으로 서비스 접근

**권장 해결책**:
1. DID Universal Resolver 도입
2. 신뢰할 수 있는 Wallet Server 레지스트리 관리
3. `did:web` 또는 `did:key` 같은 자체 검증 가능 DID method 사용
4. Wallet URL을 사전 등록된 목록과 대조

---

#### 2.1.2 Wallet Event Stream 인증 부재

**위치**: `apps/gateway/server.js:576-597`

**취약점 설명**:
SSE 엔드포인트에 인증이 없어 누구나 다른 사람의 DID로 이벤트를 수신할 수 있습니다.

```javascript
app.get("/v1/wallet/events", (req, res) => {
  const did = req.query.did;  // 인증 없이 DID만으로 연결
  if (!did) {
    return res.status(400).json({ error: "did_required" });
  }
  // ... 어떤 인증도 없이 스트림 연결
  addWalletStream(did, res);
});
```

**공격 시나리오**:
1. 공격자가 피해자 DID를 알아냄 (DID는 공개 정보)
2. `GET /v1/wallet/events?did=did:miid:victim-uuid` 요청
3. 피해자에게 발생하는 모든 challenge 이벤트 수신
4. **정보 유출**: 어떤 서비스에 로그인 시도하는지, 요청되는 claims 등

**영향도**:
- 사용자 행동 추적 가능
- Challenge 정보 노출 (service_id, scopes, requested_claims)
- 프라이버시 침해

**권장 해결책**:
1. SSE 연결 시 DID 소유권 증명 요구 (서명 기반 토큰)
2. 일회성 connection token 발급 후 검증
3. IP 기반 rate limiting 추가

---

### 2.2 중간 (Medium Severity)

#### 2.2.1 서명 페이로드 바인딩 불완전

**위치**: `apps/gateway/server.js:1119-1124`

**취약점 설명**:
서명 페이로드에 `service_id`가 포함되지 않아, 이론적으로 동일한 `client_id`를 가진 다른 서비스 컨텍스트에서 서명이 재사용될 수 있습니다.

```javascript
const payload = toPayloadString({
  challenge_id: challenge.id,
  nonce: challenge.nonce,
  audience: challenge.client_id,  // client_id만 포함
  expires_at: challenge.expires_at
  // service_id, scopes 미포함
});
```

**잠재적 문제**:
- 동일 client_id를 공유하는 서비스 간 서명 혼동
- scope escalation 가능성 (요청한 것보다 넓은 권한)

**권장 해결책**:
```javascript
const payload = toPayloadString({
  challenge_id: challenge.id,
  nonce: challenge.nonce,
  audience: challenge.client_id,
  service_id: challenge.service_id,  // 추가
  scopes: challenge.scopes,           // 추가
  expires_at: challenge.expires_at
});
```

---

#### 2.2.2 Challenge DID 검증 취약

**위치**: `apps/gateway/server.js:1085-1088`

**취약점 설명**:
`did_hint`가 없는 challenge는 모든 DID가 승인할 수 있습니다.

```javascript
if (challenge.did_hint && challenge.did_hint !== did) {
  return res.status(403).json({ error: "did_mismatch" });
}
// did_hint가 없으면 어떤 DID로도 승인 가능
```

**잠재적 문제**:
- 멀티 Wallet 환경에서 의도치 않은 DID로 승인
- 사용자가 원하지 않는 identity로 서비스 가입

**권장 해결책**:
- Challenge 생성 시 target DID를 명시적으로 지정
- 또는 Wallet 측에서 사용자에게 DID 선택 UI 제공 (현재 구현됨)

---

#### 2.2.3 Wallet Sign Secret 내부 신뢰

**위치**: `apps/wallet/server.js:288-295`

**취약점 설명**:
`WALLET_SIGN_SECRET`이 환경 변수로 Wallet App과 Wallet Server 간에 공유됩니다.

```javascript
const signSecret = getSignSecret();
if (signSecret) {
  const sent = req.headers["x-wallet-sign-secret"];
  if (sent !== signSecret) {
    return res.status(401).json({ error: "unauthorized_sign_request" });
  }
}
```

**잠재적 문제**:
- 같은 머신의 다른 프로세스가 환경 변수 읽기 가능
- 로컬 공격자가 서명 요청 가능

**현재 완화 요소**:
- Wallet App이 시작 시 랜덤 secret 생성 (`main.js:48`)
- 외부 네트워크에서는 접근 불가 (localhost 바인딩)

**권장 해결책**:
- IPC 기반 통신으로 전환
- 또는 요청별 일회성 토큰 사용

---

#### 2.2.4 세션 재사용 모드 우회

**위치**: `apps/gateway/server.js:770-805`

**취약점 설명**:
`WALLET_AUTHORITATIVE_MODE`가 비활성화되면 Wallet 승인 없이 기존 세션을 재사용할 수 있습니다.

```javascript
app.post("/v1/auth/reuse-session", (req, res) => {
  if (WALLET_AUTHORITATIVE_MODE) {
    return res.status(403).json({
      error: "wallet_authoritative_mode_enabled",
      message: "Session reuse shortcut is disabled."
    });
  }
  // ...Wallet 승인 없이 세션 재사용
});
```

**잠재적 문제**:
- 사용자 동의 없이 세션 재사용
- DID 자기주권 원칙 위배

**권장 해결책**:
- `WALLET_AUTHORITATIVE_MODE`를 기본값 `true`로 설정 (현재도 그러함)
- 운영 환경에서 이 값 변경 시 경고 로깅

---

#### 2.2.5 Authorization Code Replay 가능성

**위치**: `apps/gateway/server.js:1201-1234`

**취약점 설명**:
Authorization code가 사용 후 즉시 무효화되지만, 짧은 시간 창에서 경쟁 조건 발생 가능.

```javascript
const authCode = store.findAuthCodeByCode(code);
if (!authCode) {
  return res.status(400).json({ error: "invalid_code" });
}
if (authCode.used_at) {
  return res.status(409).json({ error: "code_already_used" });
}
// ... 토큰 발급 후
store.updateAuthCodeUsed(code, store.nowIso());
```

**현재 완화 요소**:
- 2분 TTL로 시간 제한
- `used_at` 검사로 재사용 방지

**추가 권장**:
- 데이터베이스 레벨 unique constraint 활용
- 원자적 "claim and use" 연산 구현

---

### 2.3 낮음 (Low Severity)

#### 2.3.1 Token Exchange Proof-of-Possession 부재

**설명**:
Authorization code만으로 토큰 발급 (OAuth 2.0 표준 준수).
PKCE나 DPoP 같은 추가 바인딩 없음.

**영향도**:
- Code 유출 시 토큰 탈취 가능
- 하지만 code TTL이 2분으로 짧음

**권장**:
- PKCE (code_verifier/code_challenge) 도입 고려
- 또는 mTLS 기반 클라이언트 인증

---

#### 2.3.2 SSE Stream 복구 신뢰성

**설명**:
SSE 연결 끊김 시 이벤트 유실 가능. 이벤트 ID/재전송 메커니즘 없음.

**영향도**:
- Challenge 이벤트 놓침 → 승인 UI 미표시
- 사용자 경험 저하

**권장**:
- SSE `id` 필드 활용하여 `Last-Event-ID` 기반 복구
- 또는 메시지 큐 기반 보장 전달 (TODO에 이미 기재됨)

---

#### 2.3.3 Service Client Credential 고정

**위치**: `apps/gateway/server.js:39-42`

**설명**:
기본 서비스 클라이언트 자격증명이 코드에 하드코딩됨.

```javascript
const defaultClientSecret = process.env.SERVICE_CLIENT_SECRET || "dev-service-secret";
```

**영향도**:
- 개발 환경에서만 사용되므로 실제 위험은 낮음
- 운영 환경 배포 시 변경 필수

**권장**:
- 운영 환경 체크리스트에 credential 변경 포함
- `dev-` prefix credential 사용 시 경고 로깅

---

## 3. 설계 수준 권장사항

### 3.1 DID Method 개선

| 현재 | 권장 | 우선순위 |
|------|------|----------|
| `did:miid` (로컬 UUID) | `did:key` (자체 검증 가능) | 높음 |
| | `did:web` (도메인 기반) | 중간 |
| | Universal Resolver 통합 | 중간 |

**`did:key` 장점**:
- 공개키가 DID 자체에 인코딩됨
- 외부 조회 없이 즉시 검증 가능
- W3C 표준 준수

```
현재: did:miid:550e8400-e29b-41d4-a716-446655440000
권장: did:key:z6Mkf5rGMoatrSj1f4CyvuHBeXJELe9RPdzo2PKGNCKVtZxP
```

### 3.2 DID Document 검증 강화

```
현재 흐름:
  Wallet → (wallet_url 제공) → Gateway → (fetch) → Wallet Server → DID Doc

권장 흐름 (옵션 A - Universal Resolver):
  Wallet → Gateway → Universal Resolver → DID Doc (캐시 가능)

권장 흐름 (옵션 B - did:key):
  Wallet → Gateway → DID 자체에서 공개키 추출 (외부 조회 불필요)
```

### 3.3 Wallet SSE 인증 추가

```javascript
// 권장 구현
app.get("/v1/wallet/events", async (req, res) => {
  const did = req.query.did;
  const connectionToken = req.query.token;

  // 1. connection token 검증 (사전에 서명으로 발급)
  const valid = await verifyConnectionToken(did, connectionToken);
  if (!valid) {
    return res.status(401).json({ error: "invalid_connection_token" });
  }

  // 2. 정상 연결
  addWalletStream(did, res);
});
```

### 3.4 서명 페이로드 강화

```javascript
// 권장 구현
const payload = toPayloadString({
  challenge_id: challenge.id,
  nonce: challenge.nonce,
  audience: challenge.client_id,
  service_id: challenge.service_id,      // 추가
  scopes: challenge.scopes.sort(),       // 추가 (정렬하여 정규화)
  requested_claims: challenge.requested_claims.sort(), // 추가
  expires_at: challenge.expires_at
});
```

### 3.5 Gateway 역할 분산

| 현재 Gateway 역할 | 권장 분리 |
|-------------------|-----------|
| Challenge 생성 | 유지 |
| 서명 검증 | **Verifier Service로 분리** |
| Session 관리 | 유지 |
| DID Resolution | **Resolver Service로 분리** |

---

## 4. 요약 및 로드맵

### 4.1 현재 상태 평가

**적합 용도**: 개발/데모/PoC 단계
**프로덕션 준비도**: 낮음 (심각 이슈 해결 필요)

### 4.2 보안 이슈 우선순위

| 우선순위 | 이슈 | 영향 | 예상 공수 |
|----------|------|------|-----------|
| **P0** | DID Resolution 신뢰 문제 | 신원 사칭 | 높음 |
| **P0** | Wallet SSE 인증 부재 | 정보 유출 | 중간 |
| **P1** | 서명 페이로드 바인딩 | Scope 혼동 | 낮음 |
| **P1** | Challenge DID 검증 | 의도치 않은 승인 | 낮음 |
| **P2** | Sign Secret 내부 신뢰 | 로컬 공격 | 중간 |
| **P2** | Token PoP 부재 | Code 탈취 | 중간 |

### 4.3 권장 로드맵

**Phase 1 - 필수 보안 (프로덕션 전)**
- [ ] DID Resolution 신뢰 체계 구축 (did:key 도입 또는 Resolver 레지스트리)
- [ ] Wallet SSE 엔드포인트 인증 추가
- [ ] 서명 페이로드에 service_id, scopes 추가

**Phase 2 - 강화**
- [ ] PKCE 지원 추가
- [ ] SSE 이벤트 ID 및 재전송 메커니즘
- [ ] 감사 로깅 체계 구축

**Phase 3 - 분산화**
- [ ] Gateway 역할 분리 (Verifier, Resolver)
- [ ] did:web 또는 did:ion 지원 추가
- [ ] 멀티 Gateway 연합 구조

---

## 부록: 관련 코드 위치

| 컴포넌트 | 파일 | 주요 보안 관련 코드 |
|----------|------|---------------------|
| Gateway | `apps/gateway/server.js` | DID Resolution (306-321), SSE (576-597), 서명 검증 (1074-1168) |
| Wallet Server | `apps/wallet/server.js` | 키 생성 (133-135), 서명 (284-316) |
| Wallet App | `apps/wallet/main.js` | 승인 로직 (541-616), SSE 연결 (791-819) |
| Service Backend | `apps/service-backend/server.js` | Token Exchange (541-606) |

---

*최종 검토일: 2024-01*
*검토자: Security Review*
