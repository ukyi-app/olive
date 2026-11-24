# 지시 송신의 한 자리 (`send-gate.ts`)

배정·시작 박자(`assign-loop.ts`)와 재전송 박자(`resend.ts`)가 봉한 지시를 내보내기 포트(`InstructionSink`)에 싣는 공유 함수다. **시작 봉투(`task_start`)는 `src/`에서 이 함수로만 포트에 닿는다.** 시작이면 싣기 전에 그 봉투의 실행·요청 ID로 장부에 송신 표식(`markStartDispatch`)을 커밋하고, 답이 `ok`일 때만 싣는다.

이유: 장부의 D-90 자동 닫기(`closeUnreceivedRun`)는 "표식이 없는 실행은 한 번도 실리지 않았다"에 기댄다(`src/ledger/ledger.md` "받은 적 없는 실행의 닫기"). 표식 없이 시작 봉투가 한 번이라도 실리면, 실행기가 받은 실행을 감독이 "받은 적 없음"으로 닫아 작업 자리를 풀고 일이 겹친다. 그래서 표식이 거절·던짐·꼴이 틀린 답이면 싣지 않는다(닫는 쪽으로 틀린다).

## 공개 면

```ts
sendInstruction<S>(holder: { sink: InstructionSink, beatValid?: () => boolean }, envelope: Envelope, start: StartMark<S> | null, plain?: PlainCheck<S> | null): Promise<GateResult<S>>
// plain: 시작이 아닌 봉투의 마지막 확인(지금은 갱신의 여유 판정). 유효 문 바로 뒤, 포트 호출 바로 앞에 부른다
PlainCheck<S> = { check: () => S | null, stops: (value: unknown) => value is S }

StartMark<S> = {
  marker: StartMarker        // ports.ts: Pick<Ledger, "markStartDispatch">. 박자가 읽고 쓰는 그 장부 객체
  at: number                 // 표식에 적는 시각(박자가 마지막으로 읽은 시각)
  lastCheck?: () => S | null // 표식 뒤, 포트 호출 직전의 마지막 확인. 던지지 않아야 한다
  stops?: (value: unknown) => value is S // 마지막 확인의 답이 부르는 쪽의 거절인지. 없으면 null 밖의 답은 모두 check_malformed
}

GateResult<S> =
  | { kind: "answered", answer: unknown }        // 포트를 불렀고 돌아왔다(답의 꼴은 부르는 쪽이 본다)
  | { kind: "threw" }                            // 포트를 불렀고 던졌다(실렸는지 모른다)
  | { kind: "sink_unavailable" }                 // 포트를 얻지 못해 부르지 않았다. 이번 시도는 새 표식을 쓰지 않았다(앞선 시도의 표식은 남아 있을 수 있다)
  | { kind: "unmarked", markReason: MarkFailure } // 시작인데 표식이 ok가 아니어서 부르지 않았다
  | { kind: "stopped", value: S }                // 마지막 확인(시작은 lastCheck, 아니면 plain.check)이 부르는 쪽의 거절(stops가 참)을 냈다
  | { kind: "check_malformed" }                  // 마지막 확인이 null도 거절도 아닌 값(undefined·숫자·남의 객체 등)을 냈다. 싣지 않았다(시작이면 표식이 커밋됐을 수 있다)
  | { kind: "beat_closed" }                      // 박자 유효 문이 닫혀 부르지 않았다(표식 앞이면 이번 호출의 표식 0, 시작의 표식 뒤면 이번 표식 호출 1회: created가 true면 새 행 1, false면 새 행 0·이미 있는 행 1)

MarkFailure = 장부의 거절 이름 | "threw" | "malformed_answer" | "marker_missing" | "envelope_unreadable"

callAfterGate(get: () => { receiver, fn, args }, open: () => boolean): GatedCall   // 박자 안의 장부 쓰기·표식 하나. args의 원소는 open 전에 함수 안 배열로 옮긴다
GatedCall = { kind: "called", value } | { kind: "closed" } | { kind: "threw" }   // get·원소 읽기가 던지거나 fn이 함수가 아니면 부르지 않은 채 threw
holdBeatValid(holder: { beatValid?: () => boolean }): () => boolean   // 유효 문을 한 번 얻는다. 배정·수명·끊김 박자도 장부 쓰기마다 이것으로 얻는다
```

세 박자는 이 결과를 자기 결과로 옮긴다: 배정·시작 박자는 `recorded_not_sent`의 `reason: "start_unmarked"`(+ `markReason`)·`"sink_unavailable"`·`"beat_closed"`, 재전송 박자는 `not_sent`의 앞 두 이름(둘 다 `delivery: "not_sent"`)과 `withheld`의 `beat_closed`, 수명 박자(갱신·취소·조회, 시작이 아닌 봉투)는 `renew_recorded_not_sent`·`stop_recorded_not_sent`·`query_not_sent`의 `reason: "beat_closed"`·`"sink_unavailable"`(`delivery: "not_sent"`, 조회는 기다리는 조회에 넣지 않는다)다. 갱신은 `plain`으로 마지막 여유 판정을 넘기고, `stopped`면 그 판정이 낸 `renew_recorded_not_sent`(`clock_unavailable`·`renew_margin_lost`·`deadline_within_margin`)가 결과다. `check_malformed`는 재전송이 `withheld`의 `check_malformed`, 갱신이 `renew_recorded_not_sent`의 `check_malformed`(`not_sent`)로 옮긴다. 두 박자는 자기 확인이 만든 거절 객체만 `stops`로 알아본다(`WeakSet`).

`holder.beatValid`는 박자 유효 문을 받는 선택 칸이다. 진입 때 한 번 읽어 `holder`를 수신자로 함께 쥐고, 부를 때 `callHeld`(`Reflect.apply`)로 부른다: 칸도 함수의 `bind`·`call`도 다시 읽지 않으므로 상속한 `bind`가 없는 함수도 `this`가 `holder`인 채 불린다. 빠지면 늘 유효, 칸을 읽다 던지거나 함수가 아니면 늘 닫힘, 부를 때 던지거나 `true`가 아니면 닫힘이다. 두 박자는 자기 포트 묶음을 `holder`로 넘기므로 조립이 박자에 넘긴 유효 문이 그대로 이 칸이다. 배정·수명·끊김 박자의 장부 쓰기도 같은 함수(`holdBeatValid`)로 장부 쓰기마다 칸을 한 번 읽고 한 번 부른다.

## 차례

1. 시작인지 가른다. **부르는 쪽의 말이 아니라 봉투의 `header.action`으로 가른다.** 읽지 못하면 시작으로 친다. 봉투는 여기서 한 번만 읽는다(`readEnvelope`): 정규 직렬화(`canonicalJson`)로 칸마다 한 번 읽은 글을 다시 풀어 **접근자 없는 데이터 사본**을 만들고, 동작·요청 ID·실행 ID 판정, 표식의 입력, 포트에 넘기는 봉투 모두 이 사본만 쓴다. 원래 봉투는 진입 뒤 다시 읽지 않는다. 같은 칸을 두 번 읽으면 접근자의 시간이 두 번 들어 첫 유효 문이 늦어지고(998ms에 머리 1ms면 한 번은 999, 두 번은 1,000) 두 읽기가 다른 값을 낼 수 있다. 원래 봉투를 포트에 넘기면 내보내기 포트의 직렬화가 머리·본문 접근자를 유효 문 뒤에 다시 돌리고, 값이 바뀌는 접근자면 표식의 ID와 실리는 ID가 갈린다. 사본을 만들지 못하면(접근자가 던짐, 정규 직렬화가 받지 않는 값) 시작으로 읽혀 포트를 부르지 않는다: 같은 직렬화를 하는 내보내기 포트도 그 봉투를 싣지 못한다. 시작인데 `start`가 `null`이면 `unmarked`/`marker_missing`이고 포트를 부르지 않는다.
2. **입력 객체의 칸을 진입 때 한 번씩 읽어 지역 값에 쥔다.** 내보내기 포트의 수신 객체(`holder.sink`)와 함수(`sink.send`), 박자 유효 문(`holder.beatValid`), 시작이면 `start`의 시각(`at`)·마지막 확인(`lastCheck`)·거절 판별(`stops`)·표식 포트(`marker`)와 그 메서드(`markStartDispatch`), 시작이 아니면 `plain`의 `check`·`stops`, 그리고 1에서 읽은 봉투의 두 ID다. 마지막 확인과 거절 판별은 그 칸을 읽은 객체(`start`·`plain`)를 수신자로 쥔다: 자기 상태를 읽는 클래스 메서드도 `this`를 잃지 않는다. **마지막 확인 칸의 꼴이 틀리면 여기서 `check_malformed`이고 표식·송신 0이다**: 시작의 `lastCheck`는 함수·`undefined`·`null`만 받고(`undefined`·`null`은 확인 없음), `plain`은 두 칸 모두 필수라 하나라도 함수가 아니면 꼴 틀림이다. 빠진 필수 확인을 "확인 없음"으로 읽으면 확인이 막으려던 송신이 나간다. 박자 유효 문 뒤에는 쥔 함수·값만 쓴다: 칸이 접근자면 유효 문 뒤에 읽는 순간 그 안에서 흐른 시간을 유효 문도 마지막 확인도 보지 못한다(`start.lastCheck` 접근자에 1ms면 박자 만료 정각에 포트가 불린다). 진입 때 읽으므로 접근자의 시간은 첫 유효 문이 본다. `start`의 시각·마지막 확인을 읽다 던지면 `unmarked`/`threw`(표식·송신 0), 표식 포트나 메서드를 읽다 던지면 3에서 부르지 않은 채 `threw`다. 내보내기 포트를 얻다 던지거나 함수가 아니면 포트를 부르지 않고 **이번 시도는 새 표식을 적지 않는다**(앞선 시도의 표식은 남아 있을 수 있다. 시작이면 마지막 확인을 표식 없이 먼저 보고, 그것이 싣지 말라면 `stopped`, 아니면 `sink_unavailable`. 재전송 박자의 결과 차례다).
3. 시작이면 2에서 쥔 두 ID로 인자 `{ runId, requestId, now: at }`를 만들고, `callAfterGate`로 2에서 쥔 표식 포트와 그 메서드를 넘겨 박자 유효 문을 보고 바로 `Reflect.apply`로 부른다. 유효 문이 닫혔으면 `beat_closed`(이번 호출의 표식 0. 같은 열기의 앞선 시도가 적은 행은 남을 수 있다). `{ ok: true, created: boolean }`만 `ok`다(`created: false`, 같은 열기에서 이미 적은 표식도 `ok`). 거절이면 그 이름, 던지면 `threw`, 다른 꼴이면 `malformed_answer`, 봉투에서 두 ID를 읽지 못하면 `envelope_unreadable`이고 모두 싣지 않는다. 답의 칸(`ok`, `created`, `reason`)은 예외 처리 안에서 칸마다 한 번만 읽고, 판정과 반환은 그 읽은 값으로만 한다: 칸이 접근자면 다시 읽을 때 값이 바뀌어 검사한 거절이 성공(`null`)으로 돌아갈 수 있다. 칸을 읽다 던지면 메서드가 던진 것과 같은 `threw`다.
4. **마지막 판정 하나**: 박자 유효 문을 다시 보고(시작이면 표식 커밋에 쓴 시간) 바로 마지막 확인(시작은 2에서 쥔 `lastCheck`, 시작이 아니면 `plain.check`)을 부른다. **답은 `null`만 싣기다.** `stops`가 알아보는 거절이면 `stopped`, 그 밖(`undefined`·숫자·남의 객체 등)은 꼴이 틀린 답이라 `check_malformed`이고 싣지 않는다: `?? null`처럼 모름을 싣기로 읽으면 확인이 막으려던 송신이 나간다(`send-gate.test.ts` "마지막 확인의 답은 null만 싣기다"). 갱신의 `plainCheck`는 장부 시계를 한 번 읽어 앞 임대 끝·봉투 시한·작업 기한의 13,000ms 여유를 본다: 유효 문 안의 읽기에 1ms가 흘러 여유가 12,999ms면 `stopped`이고 포트를 부르지 않는다(`life-loop.test.ts` "갱신의 마지막 여유 판정"). 유효 문이 닫혔으면 `beat_closed`(표식은 남았을 수 있다). 재전송 박자는 `lastCheck`에서 미리 얻어 둔 시계 함수로 시계를 다시 읽어 발행 + 19000ms 한도를 본다. 표식의 커밋(fsync)과 유효 문 안의 읽기(조립에서는 장부 건강·허가)에 걸린 시간을 이 읽기가 잰다. 그래서 발행 + 19000ms에 읽으면 싣고, 유효 문 안에서 1ms가 흘러 19001ms가 되면 `start_expired`이고 포트를 부르지 않는다(`resend.test.ts` "시작의 마지막 판정").
5. 2에서 쥔 함수를 수신 객체를 `this`로 해 부른다(`Reflect.apply`). 마지막 판정과 호출 사이에 다른 외부 코드가 없다. 1~5는 동기라 **표식·마지막 판정과 포트 호출 사이에 `await`가 없다**(첫 `await`가 포트 호출이다. 정적 시험이 본다). 포트의 답을 받으면 바로 돌아온다. 송신 뒤 시계 읽기는 부르는 쪽(재전송 박자)의 일이다.

**남는 틈(시작·갱신의 마지막 판정).** 박자 기한은 단조 시계로, 시작 한도와 갱신 여유는 장부 시계로 잰다. 한 번의 읽기로 둘을 볼 수 없으므로 비용이 큰 읽기(유효 문 안의 장부 읽기)를 앞에, 시계 함수의 호출 하나를 맨 끝에 둔다. 그 시계 호출 자체에 걸린 시간이나 그 안의 상태 변화는 박자 유효 문이 다시 보지 않는다. 경계 시험 도구의 훑기에서 시작·갱신 시나리오의 위반은 마지막 확인의 호출 한 지점(그 안의 `clock.now` 호출. `start`를 감싸 세면 `lastCheck` 호출)에만 남는다. 반대 차례(마지막 확인 → 유효 문)는 유효 문 안의 장부 읽기 전체가 시작 한도 밖에 남는다. 시작의 마지막 판정은 유효 문 → 시작 시한(장부 시계) → 송신 차례이고, 장부 시계 읽기 자체에 쓴 시간은 박자 기한 판정에 들어가지 않는다(장부 시계는 조립의 직접 함수라 접근자·포트 지연이 없다는 전제).

취소·확정·갱신·조회 같은 시작이 아닌 봉투는 2·4·5를 한다(표식을 부르지 않고 `start`를 보지 않는다). 4의 마지막 확인은 `plain`이 있을 때만이고 지금은 갱신뿐이다. 포트를 얻지 못하면 마지막 확인 없이 `sink_unavailable`이다.

## 표식 뒤에 싣지 않고 돌아가는 길

표식을 커밋한 뒤 싣지 못한 것은 안전한 쪽이다: 그 실행은 다른 열기에서 자동으로 닫히지 않는다(`sent_by_other_open`, 손 닫기로 간다). 같은 열기에서는 표식이 닫기를 막지 않지만, 그때 닫는 근거는 실행기의 전체 답이 그 실행을 싣지 않았다는 것이라 실제로 싣지 않은 시작과 어긋나지 않는다. 표식은 포트 호출 직전에 두어 이 길을 줄였고, **실제 장부를 표식 포트로 그대로 쓸 때** 남는 길은 아래뿐이다.

- **표식 뒤 박자 유효 문이 닫혔을 때**(`beat_closed`). 표식 커밋 안에서 박자 기한이 지났다(이번 표식 호출 1회·송신 0. 그 호출이 `created: true`면 새 행 1, 같은 열기의 앞선 시도가 이미 적어 `created: false`면 새 행 0이고 이미 있는 행 1).
- **재전송 시작의 마지막 시계 읽기가 막을 때.** 표식 커밋 중이나 그 뒤 유효 문 안에서 발행 + 19000ms를 넘었거나(`start_expired`) 시계를 읽지 못했다(`withheld`/`clock_unavailable`). 순서상 표식이 시계 읽기보다 앞이어야 하므로(커밋 시간을 재야 한다) 이 길은 없앨 수 없다.
- **포트가 싣지 않았다고 답할 때**(`no_connection`·`too_late_to_send`).
- **포트가 던지거나 정의 밖의 값을 돌려줄 때**(`delivery: "unknown"`). 실렸을 수 있다.
- **표식 커밋 뒤 포트 호출 전에 프로세스가 죽을 때.**

주입한 표식 포트(실제 장부를 감싼 것 등)가 커밋한 뒤 던지거나 꼴이 틀린 답을 내면, 표식 한 줄이 남고 `unmarked`(`threw`·`malformed_answer`)로 돌아온다. 이 목록 밖이지만 역시 싣지 않았으므로 자동 닫기를 덜 하는 쪽이다. 그래서 `unmarked`·`sink_unavailable`이 말하는 것은 "이번 시도는 싣지 않았다"이지 "장부에 표식이 없다"가 아니다: 앞선 시도가 같은 열기에서 적은 표식은 남아 있을 수 있다.

배정·시작 박자는 표식을 봉한 뒤에 부르므로, 초안·봉하기의 실패(`draft_threw`, `seal_threw`, 거절 이름)와 장부의 시작 거절에서는 이번 시도가 새 표식을 쓰지 않는다.

## 정적 시험 (`test/supervisor/dispatch/start-send.test.ts`)

**보는 것.** `src/`의 모든 `.ts`(줄 전체 주석은 뺀다)에서 송신처럼 보이는 자리를 모양별로 센다: 메서드 호출 `.send(`, 속성 읽기 `.send`, 꺼낸 함수의 호출 `send(`(메서드 선언은 뺀다), `Reflect.apply(`, 문자열 이름 접근 `["send"]`, `send`를 꺼내는 구조 분해(`{ ... } =`의 중괄호 안에 다른 중괄호가 없는 것. 여러 줄과 별칭 `{ send: forward }`도 잡는다), `Reflect.apply`를 부르지 않고 읽는 자리(다른 이름에 담기, 인자로 넘기기)와 `Reflect`에서 `apply`를 꺼내는 구조 분해, 그렇게 담은 이름의 호출(`Reflect.apply`의 호출과 같이 센다). 그 목록이 정한 목록과 같아야 한다(이 파일의 네 자리: `send` 읽기 하나와 `Reflect.apply` 셋(포트 호출, `callAfterGate`, 박자 유효 문·마지막 확인·거절 판별을 쥔 수신자로 부르는 `callHeld`), 취소 도구 어댑터, 실행기 → 감독 연결, 순서기가 박자 함수를 부르는 `Reflect.apply` 한 자리, D-90 닫기 박자(`unreceived.ts`)가 `Reflect.apply`를 `apply`에 담는 한 자리와 그 이름으로 박자 처음에 꺼내 쥔 포트·장부 함수를 그 수신자로 부르는 네 자리: 전역 포트와 증거 `read`의 조회(`invoke`), 장부 목록 읽기, `confirm`, 장부 닫기). 수명 박자·재전송·배정은 이 함수로만 싣으므로 목록에 없다(직접 송신이 다시 생기면 목록이 달라진다). 순서기와 D-90 박자가 시작 봉투에 닿을 수 없음은 같은 파일의 따로 된 시험이 본다. 그리고:

- `startDraft`를 부르는 모듈은 배정·시작 박자와 재전송 박자뿐이고, 둘에는 송신 자리가 없고 `sendInstruction`을 정확히 한 번 부른다.
- `task_start`를 문자열로 쓰는 감독 모듈은 봉투 모듈·재전송 박자·이 파일뿐이다. 감독에서 서명 포트(`.seal(`)나 계약의 `sealEnvelope`를 부르는 자리는 봉투 모듈과 정지 동기화의 답(`stop_sync_reply`만 받는 포트)뿐이다.
- 이 파일 밖의 송신 자리가 있는 모듈은 `startDraft`를 부르지 않고 `task_start` 문자열이 없다. 실행기 모듈은 감독 모듈을 import하지 않는다.
- `markStartDispatch` 속성을 읽는 곳(장부 밖, 호출과 쥐기 모두)은 이 파일뿐이고, 이 함수 안의 차례는 칸 쥐기(`readEnvelope` → `send` 읽기 → `holdBeatValid` → `holdStart`) → 표식(`const marking = callAfterGate(`) → 유효 문 → 마지막 확인(`verdictOf(check, stops)`) → 포트 호출, 첫 `await`가 포트 호출이다. 표식의 `callAfterGate` 뒤 본문에는 `holder`·`start`·`target`·`envelope`·`marker`의 칸 읽기가 없고, 본문 전체에서 `start`의 칸은 읽지 않으며(`holdStart`만 읽는다) `holder`의 칸은 `holder.sink` 하나다(`holder.beatValid`는 `holdBeatValid`가 읽는다).
- `callAfterGate`(박자 안의 장부 쓰기·표식을 얻기 → 인자 원소 옮기기 → 박자 유효 문 → `Reflect.apply`로 부르는 함수)의 본문은 글자 그대로, 그 이름이 나오는 줄은 import 셋과 장부 쓰기 다섯(`assignToolRequest`·`startRun`·`recordRenewInstruction`·`recordStopInstruction`·`markLostFor`)·표식 하나를 부르는 줄뿐이다. `callHeld`의 본문(`Reflect.apply` 한 번)도 글자 그대로, 그 이름이 나오는 줄은 박자 유효 문·마지막 확인·거절 판별의 세 줄뿐이고 이 파일 밖에는 없다. 이 파일의 `Reflect.apply` 셋은 포트 호출, `callAfterGate`, `callHeld`다. `await`는 낱말로 찾으므로 뒤에 줄바꿈이 와도 잡는다.

**보지 못하는 것.** 실행 중에 만든 이름(`sink["se" + "nd"]`), 중괄호가 겹친 구조 분해(`{ a: { b }, send: f } = sink`)와 함수 매개변수의 구조 분해(`({ send: f }) => f(envelope)`), `await` 낱말 없이 포트 호출을 미루는 것(예: `return Promise.resolve().then(async () => ... await Reflect.apply(...))`는 한 번 양보한 뒤 싣지만 첫 `await`가 여전히 포트 호출이라 통과한다), 다른 이름의 메서드로 감싼 포트를 넘겨받아 부르는 함수, `Function.prototype.call.call` 같은 간접 호출, `eval`·`new Function`, `task_start`를 실행 중에 조립한 초안, `src/` 밖의 코드, 아직 없는 조립·전송 구현(예: 연결 처리기의 `send_reply` 출력을 실제로 쓰는 쪽). 실행기가 자기 키로 봉한 봉투는 감독의 시작으로 받아들여지지 않는다는 계약의 방향 규칙에 기대고, 그것을 이 시험이 보지는 않는다. 함수가 봉투의 동작으로 시작을 가르는지는 행동 시험이 본다.

시험이 세는 모양의 새 송신 자리를 더하면 목록 시험이 먼저 실패한다. 그때 그 자리가 시작 봉투를 받을 수 있으면 이 함수를 지나게 하고, 아니면 목록과 "시작 봉투를 만들 수 없음"의 근거를 함께 고친다.

## 뒤 조각이 지킬 것

- **조립이 넘기는 장부 포트는 박자가 읽고 쓰는 그 장부 객체다.** 표식은 장부 열기마다 따로 센다. 박자의 `ledger` 포트에 표식을 함께 싣는 것도 이 때문이다(`startRun`·다시 읽기와 같은 객체로 적는다). 다른 열기의 객체를 넘기면 이 열기에서 실은 시작을 장부가 가리지 못한다.
- **내보내기 포트는 받은 봉투를 지속 저장했다가 재기동 뒤에 싣지 않는다.** 그러면 새 열기의 표식 없이 시작이 실린다. 메모리의 대기는 프로세스와 함께 사라지므로 괜찮다.
- **내보내기 포트가 싣는 순간에 지킬 것은 그대로다**(`ports.ts` `InstructionSink`, 두 박자의 문서): 정지 세대, 봉투 시한, 시작의 작업 기한 여유, 맡기지 않을 실행기.
- **시작 봉투를 내는 새 길은 이 함수를 지난다.** 세션 시작(`session_start`)을 여는 작업은 같은 표식 규칙이 필요한지 장부와 함께 정한다(지금 이 함수는 `task_start`만 표식을 요구한다).
