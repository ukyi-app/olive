# 배정 정책 채우기 (`assign-policy.ts`)

배정 박자(`dispatch/assign-loop.ts`)의 정책(`AssignLoopPolicy`)과 자격 참조 정책(`CredentialRefPolicy`)의 빈 칸 셋을 배포 값으로 채우는 순수 함수다. 진입점(`src/main/supervisor.ts`)이 환경 값을, 조립(`boot.ts`)이 적용한 등록표를 넘긴다. 파일·환경·시계를 읽지 않는다.

**틀리는 방향은 늘 "배정하지 않음"이다.** 값이 없거나 맞지 않으면 채우기 전의 닫힌 값(보류·모름)과 같은 결과를 낸다.

## 공개 면

```ts
accountRevisionFromEnv(raw): { ok: true, value: string | null } | { ok: false }      // OLIVE_ACCOUNT_REVISION
profileRevisionsFromEnv(raw): { ok: true, value: ProfileRevisions } | { ok: false }  // OLIVE_PROFILE_REVISIONS
assignmentFrom(targets, profiles, policyRevision): { context: AssignmentContext, profile: "none" | "single" | "split" }
registrationsFrom(content, registry, targets): readonly Registration[]
```

## 채우는 칸

| 칸 | 원천 | 없거나 맞지 않을 때 |
|---|---|---|
| 자격 판(`credentials.revisionOf`) | `OLIVE_ACCOUNT_REVISION`(D-111, v1 revision 꼴) | 없음·빈 값: 모름(null). 자격 참조가 파일을 열지 않고 `revision_unknown`이라 배정이 `credential_unknown`으로 보류. 꼴이 틀리면 진입점 91 |
| 허용 표·기대 프로필 revision(`assignment.allowed`·`expected`) | `OLIVE_PROFILE_REVISIONS`(JSON 객체 `{ "<v1 역할>": "<revision>" }`) | 없음·빈 값·빈 객체: 기대값이 비어 모든 연결이 `expected_revision_missing`. JSON 객체가 아니거나 모르는 역할·꼴이 틀린 revision이면 진입점 91 |
| 등록행(`assignment.registrations`) | 조립이 적용한 등록표 문서(같은 바이트)와 그 상태(`RegistryState.keyFor`) | 빈 목록: 모든 연결이 `not_registered` |

꼴이 틀린 환경을 91로 하는 것은 다른 감독 환경과 같은 규칙이다(README "감독 진입점"의 환경 표). 오타가 "값 없음"과 같은 보류로 조용히 남으면 켜는 사람이 원인을 찾지 못한다.

## 함정

- **기대 프로필 revision은 하나뿐이다.** 배정 판단(`roles/assign.ts`의 `judgeAssignment`)은 기대 revision을 역할과 무관하게 하나만 받는다. 그래서 칸이 모두 한 값(`single`)일 때만 그 값을 쓰고 허용 표에서 칸이 없는 역할을 뺀다. 빼지 않으면 칸이 없는 역할의 실행기가 같은 값을 냈을 때 후보가 된다. 칸마다 값이 다르면(`split`) 하나로 고르지 못해 기대값을 비운다(모두 보류). 역할마다 견주려면 판단의 입력을 바꾸는 뒤 조각이 필요하다.
- **등록행의 keyId는 등록표 상태가 답한 값만 쓴다.** 연결 표가 서명을 확인할 때 적는 keyId와 같은 함수(`keyFor`)다. 활성 행 하나라도 상태가 믿지 않거나(`keyFor`가 답하지 않음), 문서를 해석하지 못하거나, 던지면 행을 골라 받지 않고 빈 목록이다. `keyFor`에 넘기는 TLS 신원의 `uri`는 빈 값이다: 지금 `keyFor`는 종류·대상·네임스페이스만 본다. 그 판단이 `uri`까지 보게 되면 등록행이 비어 배정이 보류된다(시험이 잡는다).
- **비활성 행은 넣지 않는다.** 그 키의 연결은 연결 표가 맞춤에서 닫아 후보에 오르지 않는다. 키를 두 역할에 쓰는 문서는 등록표 적용이 이미 거절한다.
- **등록표는 기동 때 한 번 읽는다.** 등록행도 프로세스 동안 같다. 등록표를 바꾸면 감독을 다시 띄운다(지금 규칙 그대로).

## 이 모듈에 없는 것

- **고정 계정(`accounts`):** 진입점은 비워 둔다. 고정 계정의 별칭을 감독이 어디서 읽을지 정하지 않았다(차트는 별칭을 계정 폴더의 마운트 자리 `<계정 폴더>/<별칭>`으로만 쓴다). 계정이 없으면 고르기가 `no_account`로 보류하고 자격 참조를 묻지 않는다.
- **실행 계획·요청 한도·배정 전 사실:** 시험 배정 값 조각의 일이다. 고르기는 배정 전 사실을 먼저 보므로 지금 부탁은 `evidence_missing`으로 보류된다.
- **자격 참조 포트 자체:** 조립이 `credentialPort(deps.credentialFiles, settings.credentials)`로 한 번 만든다(`accounts/credential-ref.md`). 값 송신과 같은 파일 포트·정책이다.
