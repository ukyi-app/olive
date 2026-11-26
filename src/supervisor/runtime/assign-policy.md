# 배정 정책 채우기 (`assign-policy.ts`)

배정 박자(`dispatch/assign-loop.ts`)의 정책(`AssignLoopPolicy`)과 자격 참조 정책(`CredentialRefPolicy`)의 빈 칸 넷을 배포 값으로 채우는 순수 함수다. 진입점(`src/main/supervisor.ts`)이 환경 값을, 조립(`boot.ts`)이 적용한 등록표를 넘긴다. 파일·환경·시계를 읽지 않는다.

**틀리는 방향은 늘 "배정하지 않음"이다.** 값이 없거나 맞지 않으면 채우기 전의 닫힌 값(보류·모름)과 같은 결과를 낸다.

## 공개 면

```ts
accountFromEnv(raw): { ok: true, value: AccountRef | null } | { ok: false }          // OLIVE_ACCOUNT_NAME
accountRevisionFromEnv(raw): { ok: true, value: string | null } | { ok: false }      // OLIVE_ACCOUNT_REVISION
profileRevisionsFromEnv(raw): { ok: true, value: ProfileRevisions } | { ok: false }  // OLIVE_PROFILE_REVISIONS
assignmentFrom(targets, profiles, policyRevision): { context: AssignmentContext, profile: "none" | "single" | "split" }
registrationsFrom(content, registry, targets): readonly Registration[]
```

## 채우는 칸

| 칸 | 원천 | 없거나 맞지 않을 때 |
|---|---|---|
| 고정 계정(`accounts`) | `OLIVE_ACCOUNT_NAME`(D-126, 계정 Secret을 붙이는 차트 값 `supervisor.account.name`. 계정 폴더 이름 꼴 `ACCOUNT_NAME`, 방식은 `subscription`) | 없음·빈 값: 빈 목록. 고르기가 `no_account`로 보류하고 자격 참조를 묻지 않는다(파일 읽기 0). 꼴이 틀리면 진입점 91 |
| 자격 판(`credentials.revisionOf`) | `OLIVE_ACCOUNT_REVISION`(D-111, v1 revision 꼴) | 없음·빈 값: 모름(null). 자격 참조가 파일을 열지 않고 `revision_unknown`이라 배정이 `credential_unknown`으로 보류. 별칭과 판이 함께 있어야 자격 참조가 생긴다. 꼴이 틀리면 진입점 91 |
| 허용 표·기대 프로필 revision(`assignment.allowed`·`expected`) | `OLIVE_PROFILE_REVISIONS`(JSON 객체 `{ "<v1 역할>": "<revision>" }`) | 없음·빈 값·빈 객체: 기대값이 비어 모든 연결이 보류된다. 사유는 판단의 차례대로라, 역할·대상·허용 표·등록행 검사를 통과한 연결이 `expected_revision_missing`이고 그 앞에서 걸린 연결은 그 사유다(허용 표에 없으면 `target_not_allowed`, 등록행이 없으면 `not_registered`). JSON 객체가 아니거나 모르는 역할·꼴이 틀린 revision·거듭된 역할 칸이면 진입점 91 |
| 등록행(`assignment.registrations`) | 조립이 적용한 등록표 문서(같은 바이트)와 그 상태(`RegistryState.keyFor`) | 빈 목록: 등록행 검사까지 도달한 연결이 `not_registered`다. 그 앞에서 걸린 연결은 그 사유다(역할이 허용 표에 없으면 `target_not_allowed`) |

꼴이 틀린 환경을 91로 하는 것은 다른 감독 환경과 같은 규칙이다(README "감독 진입점"의 환경 표). 오타가 "값 없음"과 같은 보류로 조용히 남으면 켜는 사람이 원인을 찾지 못한다.

## 함정

- **기대 프로필 revision은 하나뿐이다.** 배정 판단(`roles/assign.ts`의 `judgeAssignment`)은 기대 revision을 역할과 무관하게 하나만 받는다. 그래서 칸이 모두 한 값(`single`)일 때만 그 값을 쓰고 허용 표에서 칸이 없는 역할을 뺀다. 빼지 않으면 칸이 없는 역할의 실행기가 같은 값을 냈을 때 후보가 된다. 칸마다 값이 다르면(`split`) 하나로 고르지 못해 기대값을 비운다(모두 보류. 사유는 위 표의 차례). 역할마다 견주려면 판단의 입력을 바꾸는 뒤 조각이 필요하다.
- **등록행의 keyId는 등록표 상태가 답한 값만 쓴다.** 연결 표가 서명을 확인할 때 적는 keyId와 같은 함수(`keyFor`)다. 활성 행 하나라도 상태가 믿지 않거나(`keyFor`가 답하지 않음), 문서를 해석하지 못하거나, 던지면 행을 골라 받지 않고 빈 목록이다. `keyFor`에 넘기는 TLS 신원의 `uri`는 빈 값이다: 지금 `keyFor`는 종류·대상·네임스페이스만 본다. 그 판단이 `uri`까지 보게 되면 등록행이 비어 배정이 보류된다(시험이 잡는다).
- **비활성 행은 넣지 않는다.** 그 키의 연결은 연결 표가 맞춤에서 닫아 후보에 오르지 않는다. 키를 두 역할에 쓰는 문서는 등록표 적용이 이미 거절한다.
- **거듭된 역할 칸은 91이다.** `JSON.parse`는 같은 이름의 칸이 거듭되면 앞의 값을 조용히 버려, `{"diagnosis":null,"diagnosis":"p1"}`처럼 틀린 앞 값이 지나간다. 그래서 해석한 뒤 원문의 문자열 토큰 수가 칸 수의 정확히 두 배인지 본다. 거듭된 칸은 이스케이프로 쓴 같은 이름이라도 토큰을 하나 이상 더한다. 차트가 맵에서 렌더하면 거듭될 수 없으니 직접 넣은 값을 위한 검사다.
- **등록표는 기동 때 한 번 읽는다.** 등록행도 프로세스 동안 같다. 등록표를 바꾸면 감독을 다시 띄운다(지금 규칙 그대로).

## 이 모듈에 없는 것

- **둘 이상의 계정과 계정별 판:** 별칭도 판도 하나다. 계정의 순서·전환과 계정별 판은 O17의 일이다.
- **실행 계획·요청 한도·배정 전 사실:** 시험 값(`OLIVE_TEST_JOBS=on`)에서만 `test-assign.ts`가 채운다(README "시험 배정 값"). 운영 값의 진입점은 실행 계획이 없고 요청 한도가 `{ admin: 0, alert: 0 }`이라 `planNext`가 그 정책을 거절하고, 박자는 부탁을 고르기 전에 `not_run`/`policy_rejected`로 끝난다. 시험 값에서는 한도가 양수라 그다음 고르기가 배정 전 사실을 먼저 본다. 재시도 키까지 고정 T1 부탁(D-130)과 같고 앞 실행의 종료를 장부에서 확인한 부탁만 다섯 사실을 지나 역할·등록·계정 고르기로 가고, 그 밖의 부탁은 배정되지 않고, 고르기가 `true`인 사실을 누락보다 먼저 보므로 결과가 앞 실행 사실로 갈린다: 앞 실행의 종료 미확인이 `true`면 `refused`/`prior_run_end_unconfirmed`, `false`면 근거 원천이 없는 다섯 사실로 `evidence_missing` 보류, 실행·점유를 읽지 못한 박자면(고정 부탁도) 여섯 사실로 `evidence_missing` 보류다.
- **자격 참조 포트 자체:** 조립이 `credentialPort(deps.credentialFiles, settings.credentials)`로 한 번 만든다(`accounts/credential-ref.md`). 값 송신과 같은 파일 포트·정책이다.
