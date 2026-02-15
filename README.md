# MiID Managed DID SSO Prototype

로컬에서 다음 3가지를 동작시키는 최소 구현입니다.
- Wallet 서버: DID 생성/공개키 조회/챌린지 서명
- Auth Gateway 서버: 챌린지/검증/토큰/동의/보호 API
- End-to-end 데모 스크립트

## Run

```bash
cd /Users/whyun/workspace/MiID
npm install
```

터미널 1:
```bash
npm run start:wallet
```

터미널 2:
```bash
npm run start:gateway
```

한 번에 검증:
```bash
npm run demo:flow
```

메뉴바 앱 실행 (macOS):
```bash
npm run start:menubar
```

서버 + 메뉴바를 한 번에 실행:
```bash
npm run dev:desktop
```

승인 요청 자동 테스트:
```bash
npm run test:approval
```
이 스크립트는 `Approved`까지만 진행합니다(Active 전환 안 함).
기본적으로는 보안상 비활성화되어 있으며, 테스트할 때만 아래처럼 실행:
```bash
MIID_TEST_HOOKS=1 npm run dev:desktop:hot
```

서비스 최종 교환(Approved -> Active) 테스트:
```bash
npm run test:finalize
```

승인+최종교환 한 번에:
```bash
npm run test:e2e
```

수동 UX 흐름용 분리 테스트:
```bash
npm run test:request   # 승인요청 생성 (메뉴바 Pending으로 확인)
npm run test:finalize  # 메뉴바에서 승인 후 최종 교환 -> Active
```

세션 수동 철회:
- 메뉴바 `Active Sessions` 카드에서 `Revoke` 버튼 클릭

참고:
- 메뉴바 앱이 Wallet 서버를 내부에서 함께 실행합니다.
- 승인 요청 알림은 Gateway SSE(`GET /v1/wallet/events`)로 받기 때문에 주기 폴링을 사용하지 않습니다.
- 메뉴바 화면에는 `Pending Requests`와 `Active Sessions(유효 인증 목록)`이 표시됩니다.
- 개발 모드(`npm run dev:desktop*`)에서는 macOS 알림 설정 이름이 `Electron`으로 보일 수 있습니다.
- `MiID` 이름으로 보이게 하려면 패키징된 앱으로 실행하세요.

macOS 앱 패키징:
```bash
npm run build:mac
open dist/MiID-darwin-arm64/MiID.app
```

메뉴바 앱은 기본적으로 다음을 사용합니다.
- Gateway: `http://localhost:14000`
- Wallet: `http://localhost:17000`
- DID: `data/wallet.json`의 첫 번째 wallet DID (또는 `WALLET_DID` 환경변수)

## Default Ports
- Wallet: `17000`
- Gateway: `14000`

환경변수로 변경 가능:
- `WALLET_PORT`
- `GATEWAY_PORT`

## 주요 API

Gateway:
- `POST /v1/auth/challenge`
- `POST /v1/auth/verify`
- `POST /v1/token/exchange`
- `POST /v1/consents`
- `GET /v1/consents/:consentId`
- `DELETE /v1/consents/:consentId`
- `GET /v1/services/:serviceId/profile`
- `GET /v1/auth/challenges/:challengeId/status`
- `GET /v1/wallet/events?did=...` (SSE)
- `GET /v1/wallet/challenges?did=...`
- `GET /v1/wallet/sessions?did=...`
- `DELETE /v1/wallet/sessions/:sessionId`
- `POST /v1/wallet/challenges/:challengeId/approve`
- `POST /v1/wallet/challenges/:challengeId/deny`

Wallet:
- `POST /v1/wallets`
- `GET /v1/wallets/:walletId`
- `GET /v1/wallets/by-did/:did`
- `POST /v1/wallets/sign`

## Storage

실행 중 데이터는 로컬 파일로 저장됩니다.
- `data/wallet.json`
- `data/gateway.json`
