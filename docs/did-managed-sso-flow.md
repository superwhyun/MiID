# Managed DID SSO User Flow (Consent-First)

## 목표
- 사용자는 서비스 간 이동 시 최대한 끊김 없이 접근한다.
- 사용자 통제를 위해 서비스별 최초 동의와 Scope 증가 시 재동의를 강제한다.

## 주요 엔터티
- User: DID Wallet 사용자
- Auth Gateway: DID 검증/세션/토큰 발급
- Service A/B/C: 마이크로서비스

## 사용자 시나리오
1. 사용자가 Service A 진입
- Service A는 `auth/challenge` 요청
- Wallet이 nonce 서명
- Gateway가 DID 검증 후 `subject_id`(서비스별) 발급
- Service A가 세션 생성

2. 사용자가 Service B 최초 진입
- Service B는 필요한 `scopes`로 인증 시작
- 기존 동의가 없으면 동의 화면 노출
- 사용자가 동의하면 `consents` 저장 후 세션 생성

3. Service B 재진입
- 요청 scope가 기존 동의 범위와 같으면 동의 화면 생략
- 세션 또는 토큰 재발급으로 즉시 진입

4. Service B가 새 권한(scope) 요청
- 기존 scope보다 증가하면 재동의 화면 노출
- 승인 시 새 consent version 발급
- 거부 시 기존 권한 범위 기능만 허용

5. 고위험 작업(step-up)
- 결제/계정삭제 같은 action에서 step-up 인증 요구
- Wallet 재서명(또는 FIDO/생체) 성공 시 짧은 TTL 권한 토큰 발급

6. 동의 철회
- 사용자가 Service B 동의 철회
- Gateway는 consent 상태를 revoked로 변경
- 관련 세션 즉시 무효화

## 정책 요약
- 최초 동의 1회 필수
- 동일 scope는 재사용
- scope 증가 시 재동의
- 고위험 작업은 step-up
- revoke 즉시 반영
