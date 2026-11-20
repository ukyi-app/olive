# 자격 참조 (`credential-ref.ts`)

고른 계정(`selectAccount`의 계정·방식)의 자격 파일을 읽어, 계약 v1의 `credential` 네 칸(`account`, `method`, `revision`, `digest`)을 만든다. `digest`는 파일 바이트 그대로의 SHA-256이다. 값 자체는 참조에도 거절에도 싣지 않는다(계약 `v1.md` "credential은 자격의 값이 아니라…", "자격의 digest는 정확한 자격 바이트로 계산·대조한다").

## 공개 면

```ts
resolveCredentialRef(files: CredentialFiles, policy: CredentialRefPolicy, choice: { account, method }): Promise<CredentialRefAnswer>
credentialPort(files, policy): CredentialPort        // 배정기 포트(dispatch/ports.ts)의 꼴
nodeCredentialFiles: CredentialFiles                 // 실제 파일을 읽는 구현. 파일 시스템을 부르는 곳은 여기뿐
CREDENTIAL_REF_REJECTIONS                            // 거절 사유 열한 가지

CredentialFiles.read({ dir, account, key }, maxBytes) →
  { kind: "bytes", bytes } | { kind: "missing" } | { kind: "not_a_file" } | { kind: "outside_account" }
  | { kind: "too_large" } | { kind: "failed" }

CredentialRefPolicy = {
  dir: string                                        // 계정 폴더(절대 경로). 배포가 정한다
  keys: { subscription?: string, api_key?: string }  // 방식마다 읽을 파일 이름
  maxBytes: number                                   // 값의 바이트 상한
  revisionOf(account, method): string | null         // 자격 revision. 모르면 null
}

CredentialRefAnswer = { ok: true, credential: CredentialRef } | { ok: false, reason }
```

던지지 않는다. 포트·`revisionOf`가 던져도 구별된 거절로 바꾼다.

## 보장

1. **지문은 파일의 정확한 바이트로 낸다.** 읽은 `Uint8Array`를 문자열로 바꾸지 않고 줄바꿈·공백·BOM을 다듬지 않은 채 SHA-256(소문자 16진)을 낸다. 실행기가 받은 값을 대조하는 `src/executor/profile.ts`의 `credentialMatches`도 받은 `Uint8Array`를 그대로 해시하므로, 같은 바이트면 두 쪽의 지문이 같다. 시험은 BOM·비ASCII·CRLF가 든 표본을 실제 파일로 써서 기대 지문과 `credentialMatches`로 함께 대조한다.
2. **값은 결과·거절에 실리지 않는다.** 성공은 네 칸만, 거절은 사유 이름만 담는다. 지문을 낸 뒤(성공이든 거절이든) 포트가 돌려준 버퍼를 0으로 채운다. 지우는 것은 그 버퍼뿐이다: 커널의 페이지 캐시, 포트 구현 안의 다른 사본, 해시 객체의 내부 상태, GC가 옮긴 사본은 지운다고 주장하지 않는다. 모듈은 로그를 남기지 않는다.
3. **모르면 닫는다.** 아래 거절은 서로 구별되고, 어느 것도 참조를 지어내지 않는다.

| 사유 | 언제 | 파일을 여는가 |
|---|---|---|
| `policy_invalid` | `dir`이 절대 경로가 아님·NUL, `maxBytes`가 1 이상 안전 정수가 아님, 키 이름이 꼴에 맞지 않음 | 아니다 |
| `account_malformed` | 별칭이 `ACCOUNT_NAME`(`fixed.ts`)에 맞지 않음. `..`, `/`가 든 이름도 여기서 걸린다 | 아니다 |
| `method_unknown` | 방식이 `subscription`·`api_key`가 아님 | 아니다 |
| `method_not_configured` | 그 방식의 키가 정책에 없음 | 아니다 |
| `revision_unknown` | `revisionOf`가 null·꼴이 틀린 값·던짐 | 아니다 |
| `missing` | 파일이나 계정 폴더가 없음(`ENOENT`·`ENOTDIR`), 별칭 자리가 폴더가 아닌 일반 파일 | 연다 |
| `not_a_file` | 그 자리가 일반 파일이 아님(폴더, FIFO 등) | 연다 |
| `outside_account` | 별칭 자리가 링크(가리키는 곳이 다른 계정이든 루트 밖이든), 키 파일이 링크를 거쳐 그 계정 폴더 밖으로 풀림, 연 뒤 다시 본 폴더·경로·파일이 검사한 것과 다름 | 앞의 둘은 열지 않는다. 마지막은 열었지만 바이트를 읽지 않고 닫는다 |
| `read_failed` | 그 밖의 열기·읽기 오류, 포트가 던짐, 포트의 답이 꼴에 맞지 않음, `maxBytes + 1` 길이의 버퍼를 만들 수 없음(연 파일은 닫는다) | 연다 |
| `empty` | 0바이트 | 연다 |
| `too_large` | `maxBytes` 초과(포트가 상한을 어기고 돌려줘도 다시 본다) | 연다 |

`credentialPort`는 배정기 포트의 꼴(`{ known: true, credential } | { known: false }`)로 접는다. 그 꼴에는 사유 칸이 없어 위 열한 가지가 모두 `known: false` 하나가 된다. 사유가 필요한 쪽(상태 보고, 지표)은 `resolveCredentialRef`를 부르거나 포트의 꼴에 사유 칸을 더해야 한다.

## 계정 폴더의 배치

homelab 차트(`platform/olive/templates/supervisor-deployment.yaml`, `supervisor-externalsecrets.yaml`, `values.yaml`)가 정한 것을 읽은 대로 적는다. 경로는 코드에 박지 않고 `policy.dir`로 받는다.

- 감독 컨테이너의 env `OLIVE_ACCOUNTS_DIR`가 계정 폴더를 가리킨다. 그 아래 계정마다 `<별칭>/<키 이름>` 파일이다. 지금은 고정 계정 하나만 붙는다(O09 할 일 8).
- 계정 폴더 하나는 Secret `olive-account-<별칭>` 볼륨(읽기 전용, 0440)이다. 키는 `supervisor.account.key`이고 기본값은 `CLAUDE_CODE_OAUTH_TOKEN`(구독). 원본은 Infisical의 계정별 경로다. `api_key` 방식의 키(설계 `accounts.md` §6.2의 `ANTHROPIC_API_KEY`)는 차트에 아직 없다.
- Secret 볼륨은 subPath 없이 계정 폴더 자리(`<계정 폴더>/<별칭>`)에 직접 붙는다. 그래서 그 자리는 링크가 아닌 실제 폴더다. kubelet은 그 안에 키 파일을 `..data/<키>`를 가리키는 상대 링크로 두고, `..data`도 같은 폴더 안의 `..<시각>` 폴더를 가리키는 상대 링크로 두며, 갱신 때 `..data`를 바꾼다.
- 별칭과 키의 꼴이 슬래시와 점을 막아 이름만으로는 계정 폴더 밖이나 `..data` 자체를 가리키지 못한다. 그러나 이름이 맞아도 그 자리의 링크가 밖을 가리킬 수 있으므로, `nodeCredentialFiles`는 고른 계정의 폴더 안의 파일만 읽는다:
  1. 별칭 자리를 `lstat`으로 본다. 링크면 어디를 가리키든 `outside_account`, 폴더가 아니면 `missing`.
  2. 그 폴더와 키 경로를 각각 끝까지 푼 실제 경로(`realpath`)로 바꾸고, 키의 실제 경로가 폴더의 실제 경로 + 구분자로 시작하지 않으면 `outside_account`(열지 않는다). 폴더 안의 `..data`·`..<시각>`도 ".."으로 시작하므로 상대 경로의 ".."로 판정하지 않는다.
  3. 키의 실제 경로를 `O_NOFOLLOW`로 연다(그 사이 끝이 링크로 바뀌었으면 `failed`).
  4. 연 핸들로 다시 본다: 별칭 자리가 여전히 링크가 아니고 1에서 본 폴더와 (dev, ino)가 같은지, 키가 같은 실제 경로로 풀리는지, 그 경로의 파일이 연 핸들과 (dev, ino)가 같은지. 하나라도 다르면 바이트를 읽지 않고 `outside_account`.
- **남는 틈.** Node에는 `openat`(연 폴더 기준으로 열기)이 없어 "검사한 폴더 안에서 연다"를 커널에 맡기지 못한다. 위 4는 연 파일이 **다시 확인한 시점에** 그 계정 폴더 안의 검사한 경로에 있다는 것까지만 보인다(검사와 재확인 사이에 중간 링크를 바꿨다가 되돌리면 연 파일의 (dev, ino)가 달라 걸린다). 그래서 다음은 막지 못한다: 열기와 재확인 사이에 다른 폴더의 파일 자체를 이 계정 폴더 안의 그 경로로 옮기거나, 같은 파일을 하드 링크로 두 폴더에 걸어 둔 경우(같은 inode가 두 폴더에 있으면 소속을 가릴 수 없다). 실제 배치에서는 계정마다 별도의 읽기 전용 Secret 볼륨이라 볼륨을 건너는 하드 링크·이동이 되지 않는다. 루트(`policy.dir`) 자체와 그 상위 경로는 믿는다.
- 같은 이유로 Secret 갱신이 1과 4 사이에 끼면 `..data`가 바뀌어 4에서 `outside_account`가 날 수 있다(값을 잘못 내지는 않고, 다음 시도에서 새 판을 읽는다). 실제 볼륨에서 시험하지 않았다. 시험은 링크 배치만 흉내 낸다.
- 파일 끝의 줄바꿈도 값의 일부로 해시한다. 등록 쪽이 줄바꿈을 붙여 저장했다면 실행기도 같은 바이트를 받아야 지문이 맞는다(값을 다듬는 쪽은 어디에도 없다).

## revision

`revisionOf`로 받는다. **근거 미확인.**

- 설계는 계정 묶음 메타데이터 `CLAUDE_ACCOUNT_BUNDLE`(계정, revision, 등록된 방식, 방식별 지문)에 revision을 두는 안을 적었지만 `[추론]`이다(`accounts.md` §6.2). 차트는 그 키를 매핑하지 않는다(ExternalSecret의 `data`는 키 하나).
- 파일 내용(지문)에서 revision을 만들지 않는다. revision은 등록이 정한 판의 이름이고(`accounts.md` §4 "등록"), 지문과 겹치면 두 칸이 같은 것을 가리켜 "같은 revision에 다른 값"을 알아챌 길이 없어진다.
- Secret 볼륨의 `..data` 타임스탬프 폴더 이름도 쓰지 않는다. kubelet의 내부 배치이고 같은 값으로 다시 써도 바뀐다.

## 정책 값

- `maxBytes`: 계약·설계에 자격 값의 상한이 없다. 부르는 쪽이 정한다. 기본값을 두지 않는다.
- `keys`: 방식마다 차트의 키 이름. 차트 값이 바뀔 수 있어 박지 않는다.

## 이 PR에 없는 것

- 값을 실행기에 나르는 일(계약 v1에 값을 나르는 메시지가 없다, `v1.md` "credential"). 실행기의 `CredentialSource` 구현.
- 계정의 선택·순서·전환(O17), 사용량·한도 판단. 계정은 `selectAccount`가 고른 것을 그대로 받는다.
- 배정 순환(`assign-loop.ts`)에 이 포트를 붙이는 일(진입점 조각).
- 값이 실행기의 `credentialText` 규칙(UTF-8, NUL 없음)에 맞는지의 사전 검사. 맞지 않는 값은 실행기가 시작하지 않는다.

## 뒤 조각이 지켜야 할 것

- **revision과 값의 판을 묶는다.** 지금은 `revisionOf`를 먼저 부르고 파일은 따로 연다. 조립하는 쪽은 계정·방식·revision과 해시한 파일이 같은 등록 판이라는 것을 확보해야 한다. `revisionOf`가 파일과 다른 원천이면 "같은 revision에 다른 값"이 생길 수 있다(위 "revision"). kubelet은 `..data` 링크를 한 번에 바꾸므로 한 번 연 파일은 옛 판이든 새 판이든 한 판의 바이트라고 보지만(kubelet의 동작에 기댄 것), 두 번의 읽기(참조와 전달)는 다른 판을 볼 수 있다. 실제 Secret 갱신 중의 경합과 revision의 확정 원천은 미확인이다.
- **다시 읽을 때는 파일의 소속과 지문을 모두 확인한다.** 이 모듈은 지문을 낸 뒤 바이트를 버리므로 값을 나르는 쪽은 파일을 다시 읽는다. 그때 (1) 같은 계정 폴더 안의 허용된 파일인지를 위 "계정 폴더의 배치"의 규칙(별칭 자리는 실제 폴더, 키는 그 폴더 안으로 풀림, 연 핸들로 재확인)대로 보고, (2) 다시 읽은 바이트의 지문을 시작 지시의 `credential.digest`와 대조해, 어느 하나라도 어긋나면 보내지 않는다. 지문만 보면 계정이 섞인 것을 잡지 못한다: 다른 계정의 같은 파일을 두 번 읽으면 두 지문이 같다. 실행기도 지문을 대조하지만 감독이 먼저 닫는다. 전달·재시도의 방식과 실행기의 공급원은 뒤 조각의 일이다.
- **전달의 크기와 실패의 진단을 보존한다.** `maxBytes`는 값을 나르는 틀의 상한과 같거나 작아야 한다. 포트의 `known: false`만 보면 파일이 없는지, 상한을 넘었는지, 폴더 밖으로 나갔는지 알 수 없으므로, 세부 진단이 필요한 곳은 `resolveCredentialRef`의 사유를 보존한다. 값은 로그·장부·argv·outbox에 두지 않는다. `api_key` 방식의 배포 매핑(차트의 키)은 후속 조건이다.
