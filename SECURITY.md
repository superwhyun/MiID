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
| **자체 검증 가능 DID** | ✅ 양호 | `did:key` 사용으로 외부 조회 없이 검증 가능 |

### 1.2 DID 철학과 충돌하는 설계

#### 1.2.1 Gateway 중앙 집중

**현재 구현**:
- Challenge 생성/관리: Gateway
- Session 상태 관리: Gateway
- Token 발급/검증: Gateway
- Consent 저장: Gateway

**문제점**:
- Gateway가 단일 장애점(SPOF)이자 신뢰 앵커 역할
- Gateway가 compromised되면 전체 시스템 위험
- DID 철학상 검증은 분산되어야 함

**완화 요소**:
- `did:key` 사용으로 DID 검증 자체는 Gateway 없이도 가능
- Gateway는 세션/상태 관리 역할에 집중

---

## 2. 프로토콜/아키텍처 보안 문제점

### 2.1 심각 (High Severity)

#### 2.1.1 DID Resolution 신뢰 문제 (✅ 해결 완료 - 2026-02-18)

**현재 상태**:
- `did:key` 기반 검증으로 전환되어, Gateway가 요청자가 제공한 `wallet_url`을 신뢰 루트로 사용하지 않습니다.
- `wallet_url`은 프로필 조회 힌트(선택값)로만 취급됩니다.
- DID 자체에서 공개키를 추출하여 서명 검증 (`buildDidDocumentFromDidKey`)

**위치**: `apps/gateway/server.js:330-365`, `apps/gateway/server.js:412-431`

**해결 방법**:
```javascript
// did:key에서 직접 공개키 추출 (외부 조회 불필요)
function buildDidDocumentFromDidKey(did) {
  const decoded = base58btcDecode(fingerprint.slice(1));
  const publicKeyBytes = decoded.subarray(2);
  // Ed25519 공개키로 DID Document 구성
}
```

---

#### 2.1.2 Wallet Event Stream 인증 부재 (✅ 해결 완료 - 2026-02-18)

**현재 상태**:
- `/v1/wallet/events`는 `connection_token`이 필수입니다.
- 토큰은 `/v1/wallet/events/token`에서 DID 소유 증명(서명 검증) 후 짧은 TTL(60초)로 발급됩니다.
- 토큰에 DID가 바인딩되어 타인의 DID로 연결 불가

**위치**: `apps/gateway/server.js:686-763`

**해결 방법**:
```javascript
app.get("/v1/wallet/events", (req, res) => {
  const token = req.query.token;
  verifyWalletEventsConnectionToken(token, did);  // DID 바인딩 검증
  // ...
});
```

---

### 2.2 중간 (Medium Severity)

#### 2.2.1 서명 페이로드 바인딩 불완전 (✅ 해결 완료 - 2026-02-18)

**현재 상태**:
- 서명/검증 payload에 `service_id`, `requested_claims`, `approved_claims`가 포함됩니다.
- claim 배열은 정규화(중복 제거/정렬) 후 서명되어 컨텍스트 재사용 위험을 낮췄습니다.

**위치**: `apps/gateway/server.js:968-976`, `apps/gateway/server.js:1235-1243`

---

#### 2.2.2 Wallet REST 조회 엔드포인트 인증 부재 (🔶 미해결)

**위치**: `apps/gateway/server.js:1024-1094`

**취약점 설명**:
Wallet 관련 REST 조회 엔드포인트들이 DID만으로 조회 가능하며, DID 소유권 증명이 없습니다.

```javascript
app.get("/v1/wallet/challenges", (req, res) => {
  const did = req.query.did;  // DID만으로 조회 - 인증 없음
});

app.get("/v1/wallet/sessions", (req, res) => {
  const did = req.query.did;  // DID만으로 조회 - 인증 없음
});

app.get("/v1/wallet/approved", (req, res) => {
  const did = req.query.did;  // DID만으로 조회 - 인증 없음
});
```

**공격 시나리오**:
1. DID는 공개 정보 (`did:key:z6Mk...`)
2. 공격자가 피해자 DID를 알아냄
3. 피해자의 pending challenges, active sessions, approved auth codes 조회
4. **정보 유출**: 어떤 서비스에 인증 중인지, 어떤 세션이 활성화되어 있는지

**영향도**:
- 프라이버시 침해
- 사용자 행동 추적 가능
- SSE는 토큰으로 보호했지만 REST 조회는 미보호

**권장 해결책**:
```javascript
// connection_token 미들웨어 추가
function requireWalletAuth(req, res, next) {
  const token = req.headers["x-wallet-token"];
  const did = req.query.did || req.body?.did;
  try {
    verifyWalletEventsConnectionToken(token, did);
    next();
  } catch (err) {
    return res.status(401).json({ error: "unauthorized" });
  }
}

app.get("/v1/wallet/challenges", requireWalletAuth, (req, res) => { ... });
app.get("/v1/wallet/sessions", requireWalletAuth, (req, res) => { ... });
app.get("/v1/wallet/approved", requireWalletAuth, (req, res) => { ... });
```

---

#### 2.2.3 세션/승인 취소 시 DID 소유권 증명 부재 (🔶 미해결)

**위치**: `apps/gateway/server.js:1096-1185`

**취약점 설명**:
세션 revoke 및 승인 취소 시 body에 DID 문자열만 제공하면 되며, 암호학적 소유권 증명이 없습니다.

```javascript
app.delete("/v1/wallet/approved/:authCode", (req, res) => {
  const { did } = req.body || {};  // 서명 검증 없이 did만 확인
  if (authCode.did !== did) {
    return res.status(403).json({ error: "did_mismatch" });
  }
  // ... 삭제 진행 (서명 검증 없음)
});

app.delete("/v1/wallet/sessions/:sessionId", (req, res) => {
  const { did } = req.body || {};  // 서명 검증 없이 did만 확인
  // ... revoke 진행 (서명 검증 없음)
});
```

**공격 시나리오**:
1. 공격자가 피해자 DID를 알아냄
2. `DELETE /v1/wallet/sessions/{sessionId}` 요청 with `{ "did": "피해자DID" }`
3. 피해자의 활성 세션 강제 종료

**영향도**:
- DoS 공격 가능 (타인 세션 강제 종료)
- Approved auth code 취소로 인증 흐름 방해

**권장 해결책**:
```javascript
app.delete("/v1/wallet/sessions/:sessionId", async (req, res) => {
  const { did, signature, proof } = req.body || {};

  // DID 소유권 증명 검증
  const resolved = await resolveDidDocument({ did });
  const payload = toPayloadString({
    action: "revoke_session",
    session_id: req.params.sessionId,
    nonce: proof.nonce,
    expires_at: proof.expires_at
  });
  const ok = verifyWithDidDocument(resolved.didDocument, payload, signature);
  if (!ok) {
    return res.status(401).json({ error: "invalid_signature" });
  }
  // ... revoke 진행
});
```

---

#### 2.2.4 Challenge Deny 인증 부재 (🔶 미해결)

**위치**: `apps/gateway/server.js:1288-1317`

**취약점 설명**:
Challenge 거부(deny) 시 서명 검증이 없습니다. `did_hint`가 없는 challenge는 아무나 거부 가능합니다.

```javascript
app.post("/v1/wallet/challenges/:challengeId/deny", (req, res) => {
  const { did } = req.body || {};
  // 서명 검증 없음!

  if (challenge.did_hint && challenge.did_hint !== did) {
    return res.status(403).json({ error: "did_mismatch" });
  }
  // did_hint가 없으면 아무 DID로나 거부 가능
});
```

**공격 시나리오**:
1. 서비스가 `did_hint` 없이 challenge 생성 (사용자 DID 미지정)
2. 공격자가 해당 challenge_id 획득 (브로드캐스트 이벤트 수신 등)
3. 임의의 DID로 deny 요청 전송
4. 정상 사용자의 로그인 시도 방해

**영향도**:
- Challenge 거부 DoS
- approve는 서명 검증하지만 deny는 미검증 (비대칭)

**권장 해결책**:
```javascript
// 옵션 A: deny도 서명 검증
app.post("/v1/wallet/challenges/:challengeId/deny", async (req, res) => {
  const { did, signature, proof } = req.body || {};
  // 서명 검증 후 deny 처리
});

// 옵션 B: did_hint 없는 challenge의 deny 제한
if (!challenge.did_hint) {
  return res.status(403).json({
    error: "cannot_deny_broadcast_challenge",
    message: "Only targeted challenges can be denied"
  });
}
```

---

#### 2.2.5 Authorization Code Replay 가능성 (✅ 해결 완료 - 2026-02-18)

**현재 상태**:
- `/v1/token/exchange`에서 authorization code 소비를 DB 원자 연산(`consumeAuthCodeIfUnused`)으로 처리합니다.
- 동시 요청 시 1건만 성공하고 나머지는 `code_already_used`로 거부됩니다.

**위치**: `apps/gateway/server.js:1351`

---

#### 2.2.6 Challenge DID 서버 강제 바인딩 (선택적 하드닝)

**위치**: `apps/gateway/server.js:1198-1201`

**상황 설명**:
현재 모델은 "서비스가 사용자의 DID를 사전에 알지 못하고, 사용자가 Wallet에서 DID를 선택"하는 흐름을 전제로 합니다.

**권장 방향 (옵션)**:
- 기본 정책: 현재처럼 Wallet DID 선택을 허용
- 하드닝 옵션: Challenge 최초 승인 DID를 서버에 바인딩하고 이후 변경 차단

---

#### 2.2.7 Wallet Sign Secret 내부 신뢰

**위치**: `apps/wallet/server.js:351-358`

**취약점 설명**:
`WALLET_SIGN_SECRET`이 환경 변수로 Wallet App과 Wallet Server 간에 공유됩니다.

**현재 완화 요소**:
- Wallet App이 시작 시 랜덤 secret 생성
- 외부 네트워크에서는 접근 불가 (localhost 바인딩)

**권장 해결책**:
- IPC 기반 통신으로 전환
- 또는 요청별 일회성 토큰 사용

---

### 2.3 낮음 (Low Severity)

#### 2.3.1 wallet_url SSRF 잠재 위험 (🔶 하드닝 권장)

**위치**: `apps/gateway/server.js:367-373`

**취약점 설명**:
`wallet_url`은 사용자가 제공하는 값이며, Gateway가 이 URL로 직접 요청을 보냅니다.

```javascript
async function fetchWalletByDid(walletUrl, did) {
  const res = await fetch(`${walletUrl}/v1/wallets/by-did/${encodeURIComponent(did)}`);
}
```

**잠재적 공격 시나리오**:
1. 공격자가 `wallet_url`에 내부 네트워크 주소 제공
2. Gateway가 해당 주소로 요청 전송
3. 내부 네트워크 스캔 또는 클라우드 메타데이터 접근

**현재 완화 요소**:
- `wallet_url`은 프로필 조회 힌트로만 사용
- 신뢰 루트(공개키 획득)에는 사용되지 않음

**권장 해결책**:
```javascript
function isAllowedWalletUrl(url) {
  const parsed = new URL(url);
  // localhost만 허용 또는 allowlist 관리
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    return true;
  }
  // 내부 IP 대역 차단
  if (isPrivateIP(parsed.hostname)) {
    return false;
  }
  return ALLOWED_WALLET_HOSTS.includes(parsed.hostname);
}
```

---

#### 2.3.2 Challenge Broadcast 정보 노출

**위치**: `apps/gateway/server.js:919-923`

**상황 설명**:
`did_hint`가 없는 challenge는 모든 연결된 Wallet에 브로드캐스트됩니다.

```javascript
if (challenge.did_hint) {
  pushWalletEvent(challenge.did_hint, "challenge_created", eventPayload);
} else {
  broadcastWalletEvent("challenge_created", eventPayload);  // 모든 Wallet에 전송
}
```

**잠재적 영향**:
- 다중 DID 환경에서 불필요한 정보 수신
- 서비스 ID, 요청 클레임 등 정보 노출

**현재 완화 요소**:
- SSE 연결 자체가 connection_token으로 보호됨
- 설계상 의도된 동작 (사용자가 Wallet에서 DID 선택)

---

#### 2.3.3 Token Exchange Proof-of-Possession 부재

**설명**:
Authorization code만으로 토큰 발급 (OAuth 2.0 표준 준수).
PKCE나 DPoP 같은 추가 바인딩 없음.

**영향도**:
- Code 유출 시 토큰 탈취 가능
- 하지만 code TTL이 2분으로 짧음

**권장**:
- PKCE (code_verifier/code_challenge) 도입 고려

---

#### 2.3.4 SSE Stream 복구 신뢰성

**설명**:
SSE 연결 끊김 시 이벤트 유실 가능. 이벤트 ID/재전송 메커니즘 없음.

**영향도**:
- Challenge 이벤트 놓침 → 승인 UI 미표시
- 사용자 경험 저하

**권장**:
- SSE `id` 필드 활용하여 `Last-Event-ID` 기반 복구

---

#### 2.3.5 Service Client Credential 고정

**위치**: `apps/gateway/server.js:39-42`

**설명**:
기본 서비스 클라이언트 자격증명이 코드에 하드코딩됨.

**권장**:
- 운영 환경 체크리스트에 credential 변경 포함
- `dev-` prefix credential 사용 시 경고 로깅

---

## 3. 설계 수준 권장사항

### 3.1 DID Method

| 현재 | 상태 | 비고 |
|------|------|------|
| `did:key` | ✅ 적용됨 | 공개키가 DID 자체에 인코딩, 외부 조회 불필요 |
| `did:web` | 미적용 | 도메인 기반, 향후 확장 고려 |
| Universal Resolver | 미적용 | 다양한 DID method 지원 시 필요 |

### 3.2 Wallet 엔드포인트 통합 인증

SSE 연결에는 `connection_token`이 적용되었으나, REST 엔드포인트에는 미적용.

```
현재 상태:
  /v1/wallet/events       → ✅ connection_token 필수
  /v1/wallet/challenges   → ❌ 인증 없음
  /v1/wallet/sessions     → ❌ 인증 없음
  /v1/wallet/approved     → ❌ 인증 없음
  DELETE /v1/wallet/*     → ❌ 서명 검증 없음

권장:
  모든 /v1/wallet/* 엔드포인트에 connection_token 또는 서명 기반 인증 적용
```

### 3.3 상태 변경 작업 서명 요구

```javascript
// 읽기 작업: connection_token으로 충분
GET /v1/wallet/sessions → token 검증

// 쓰기/삭제 작업: 서명 필수
DELETE /v1/wallet/sessions/:id → signature 검증
DELETE /v1/wallet/approved/:code → signature 검증
POST /v1/wallet/challenges/:id/deny → signature 검증
```

### 3.4 Gateway 역할 분산

| 현재 Gateway 역할 | 권장 분리 |
|-------------------|-----------|
| Challenge 생성 | 유지 |
| 서명 검증 | **Verifier Service로 분리** |
| Session 관리 | 유지 |
| DID Resolution | **Resolver Service로 분리** |

---

## 4. 요약 및 로드맵

### 4.1 현재 상태 평가

**적합 용도**: 개발/데모/베타 테스트 단계
**프로덕션 준비도**: 중간 (P0 이슈 해결됨, P2 이슈 해결 후 프로덕션 가능)

### 4.2 보안 이슈 우선순위

| 우선순위 | 이슈 | 영향 | 상태 |
|----------|------|------|------|
| ~~P0~~ | DID Resolution 신뢰 문제 | 신원 사칭 | ✅ 해결 |
| ~~P0~~ | Wallet SSE 인증 부재 | 정보 유출 | ✅ 해결 |
| ~~P1~~ | 서명 페이로드 바인딩 | Scope 혼동 | ✅ 해결 |
| ~~P1~~ | Authorization Code Replay | 중복 교환 | ✅ 해결 |
| **P2** | Wallet REST 조회 인증 부재 | 프라이버시 침해 | 🔶 미해결 |
| **P2** | 세션/승인 취소 소유권 증명 | DoS 공격 | 🔶 미해결 |
| **P2** | Challenge Deny 인증 부재 | DoS 공격 | 🔶 미해결 |
| **P3** | wallet_url SSRF | 내부 네트워크 노출 | 🔶 하드닝 권장 |
| **P3** | Challenge Broadcast 정보 노출 | 정보 노출 | 🔶 설계 검토 |
| **P3** | Sign Secret 내부 신뢰 | 로컬 공격면 | 🔶 하드닝 권장 |
| **P3** | Token PoP 부재 (PKCE) | Code 탈취 | 🔶 하드닝 권장 |

### 4.3 권장 로드맵

**Phase 1 - 필수 보안 (완료)**
- [x] DID Resolution 신뢰 체계 구축 (did:key 도입)
- [x] Wallet SSE 엔드포인트 인증 추가 (connection_token)
- [x] 서명 페이로드에 service_id, claims 추가
- [x] Authorization Code 원자적 처리

**Phase 2 - 강화 (진행 필요)**
- [ ] Wallet REST 엔드포인트 인증 추가 (`/v1/wallet/challenges`, `/v1/wallet/sessions`, `/v1/wallet/approved`)
- [ ] 상태 변경 작업 서명 요구 (DELETE 엔드포인트)
- [ ] Challenge Deny 인증 추가
- [ ] SSE 이벤트 ID 및 재전송 메커니즘
- [ ] 감사 로깅 체계 구축

**Phase 3 - 하드닝 (선택)**
- [ ] wallet_url SSRF 방어 (allowlist/denylist)
- [ ] Wallet Sign 경로를 IPC/요청별 nonce 방식으로 전환
- [ ] PKCE 지원 추가
- [ ] Gateway 역할 분리 (Verifier, Resolver)
- [ ] did:web 또는 did:ion 지원 추가
- [ ] 멀티 Gateway 연합 구조

---

## 부록: 관련 코드 위치

| 컴포넌트 | 파일 | 주요 보안 관련 코드 |
|----------|------|---------------------|
| Gateway | `apps/gateway/server.js` | DID Resolution (330-365, 412-431), SSE 인증 (686-763), 서명 검증 (1235-1247) |
| Wallet Server | `apps/wallet/server.js` | 키 생성 (196-198), 서명 (316-333) |
| Wallet App | `apps/wallet/main.js` | 승인 로직 (541-616), SSE 연결 토큰 (618-652), SSE 연결 (797-829) |
| Service Backend | `apps/service-backend/server.js` | Token Exchange |

---

*최종 검토일: 2026-02-18*
*검토자: Security Review*
