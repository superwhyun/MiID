# MiID Architecture

이 문서는 다음 액터를 기준으로 전체 인증 아키텍처를 설명합니다.
- User
- Browser
- Service Frontend
- Service Backend
- Auth Gateway
- Auth Wallet

## 1) High-Level Component Diagram

```mermaid
flowchart LR
    U["User"]
    B["Browser"]
    SF["Service Frontend"]
    SB["Service Backend"]
    AG["Auth Gateway"]
    AW["Auth Wallet (Menubar / Local App)"]

    U -->|interacts| B
    B -->|loads UI| SF
    SF -->|API calls| SB
    SB -->|create challenge / exchange token| AG
    AG -->|approval request signal SSE_or_push| AW
    AW -->|signed approval| AG
    SB -->|session_cookie_sid| B
```

## 2) End-to-End Login Sequence

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant Frontend as Service Frontend
    participant Backend as Service Backend
    participant Gateway as Auth Gateway
    participant Wallet as Auth Wallet

    User->>Browser: Open service login page
    Browser->>Frontend: Render login screen
    Frontend->>Backend: POST /auth/start
    Backend->>Gateway: POST /v1/auth/challenge
    Gateway-->>Backend: challenge_id, nonce, expires_at
    Backend-->>Browser: Show "Waiting for approval"
    Gateway-->>Wallet: challenge_created (SSE/push)
    Wallet-->>User: Approval notification
    User->>Wallet: Approve
    Wallet->>Wallet: Sign payload with local private key
    Wallet->>Gateway: POST /v1/wallet/challenges/:id/approve (signature)
    Gateway-->>Wallet: status=verified, authorization_code
    Note over Gateway,Backend: Approved (waiting service finalize)
    Backend->>Gateway: POST /v1/token/exchange (authorization_code)
    Gateway-->>Backend: access_token (+ metadata)
    Backend->>Backend: Create app session (sid)
    Backend-->>Browser: Set-Cookie: sid=...
    Browser->>Backend: Authenticated request with sid
    Backend-->>Browser: Logged-in response
```

## 3) State Model (User Approval to Service Session)

```mermaid
stateDiagram-v2
    [*] --> Pending: challenge created
    Pending --> Approved: user approves in wallet
    Pending --> Denied: user denies in wallet
    Pending --> Expired: challenge ttl timeout
    Approved --> Pending: user cancels approval
    Approved --> Active: service backend finalizes (token exchange)
    Active --> Revoked: user revokes active session
    Denied --> [*]
    Expired --> [*]
    Revoked --> [*]
```

## 4) Responsibility by Actor

- User
  - 최종 승인/거부 의사결정
  - Active 세션 revoke 실행
- Browser
  - 서비스 UI와 세션 쿠키(`sid`) 보관
  - 토큰/개인키는 직접 보관하지 않음
- Service Frontend
  - 로그인 UI, 승인 대기 상태 표시
- Service Backend
  - challenge 요청, finalize(token exchange), 서비스 세션 발급
- Auth Gateway
  - challenge/approval/token exchange/세션 상태 관리
  - SSE/이벤트로 wallet에 승인 요청 전달
- Auth Wallet
  - 로컬 키 보관, 사용자 승인 시 서명
  - Pending/Approved/Active 상태 UI 제공

## 5) Security Notes

- 서명은 wallet 로컬 키로만 수행
- 승인 없이 finalize 불가 (`Approved` 필요)
- 서비스 로그인 판정 기준은 `Active session + valid sid`
- 브라우저는 `sid`만 유지, 민감 토큰은 서비스 백엔드 저장 권장
