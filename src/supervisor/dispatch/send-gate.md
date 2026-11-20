# 지시 송신의 한 자리 (`send-gate.ts`)

배정·시작 박자(`assign-loop.ts`)와 재전송 박자(`resend.ts`)가 봉한 지시를 내보내기 포트(`InstructionSink`)에 싣는 공유 함수다. **시작 봉투(`task_start`)는 `src/`에서 이 함수로만 포트에 닿는다.** 시작이면 싣기 전에 그 봉투의 실행·요청 ID로 장부에 송신 표식(`markStartDispatch`)을 커밋하고, 답이 `ok`일 때만 싣는다.

이유: 장부의 D-90 자동 닫기(`closeUnreceivedRun`)는 "표식이 없는 실행은 한 번도 실리지 않았다"에 기댄다(`src/ledger/ledger.md` "받은 적 없는 실행의 닫기"). 표식 없이 시작 봉투가 한 번이라도 실리면, 실행기가 받은 실행을 감독이 "받은 적 없음"으로 닫아 작업 자리를 풀고 일이 겹친다. 그래서 표식이 거절·던짐·꼴이 틀린 답이면 싣지 않는다(닫는 쪽으로 틀린다).

## 공개 면

```ts
sendInstruction<S>(holder: { sink: InstructionSink }, envelope: Envelope, start: StartMark<S> | null): Promise<GateResult<S>>

StartMark<S> = {
  marker: StartMarker        // ports.ts: Pick<Ledger, "markStartDispatch">. 박자가 읽고 쓰는 그 장부 객체
  at: number                 // 표식에 적는 시각(박자가 마지막으로 읽은 시각)
  lastCheck?: () => S | null // 표식 뒤, 포트 호출 직전의 마지막 확인. 던지지 않아야 한다
}

GateResult<S> =
  | { kind: "answered", answer: unknown }        // 포트를 불렀고 돌아왔다(답의 꼴은 부르는 쪽이 본다)
  | { kind: "threw" }                            // 포트를 불렀고 던졌다(실렸는지 모른다)
  | { kind: "sink_unavailable" }                 // 포트를 얻지 못해 부르지 않았다. 표식도 없다
  | { kind: "unmarked", markReason: MarkFailure } // 시작인데 표식이 ok가 아니어서 부르지 않았다
  | { kind: "stopped", value: S }                // 시작의 마지막 확인이 싣지 말라고 했다

MarkFailure = 장부의 거절 이름 | "threw" | "malformed_answer" | "marker_missing" | "envelope_unreadable"
```

두 박자는 이 결과를 자기 결과로 옮긴다: 배정·시작 박자는 `recorded_not_sent`의 `reason: "start_unmarked"`(+ `markReason`)·`"sink_unavailable"`, 재전송 박자는 `not_sent`의 같은 두 이름(둘 다 `delivery: "not_sent"`)이다.

## 차례

1. 시작인지 가른다. **부르는 쪽의 말이 아니라 봉투의 `header.action`으로 가른다.** 읽지 못하면 시작으로 친다. 시작인데 `start`가 `null`이면 `unmarked`/`marker_missing`이고 포트를 부르지 않는다.
2. 내보내기 포트의 수신 객체(`holder.sink`)와 함수(`sink.send`)를 얻는다. 표식과 마지막 확인보다 먼저다: 그 접근자가 뒤에 돌면 그 안에서 흐른 시간만큼 마지막 확인이 낡는다. 얻다 던지거나 함수가 아니면 포트를 부르지 않고 **표식도 적지 않는다**(시작이면 마지막 확인을 표식 없이 먼저 보고, 그것이 싣지 말라면 `stopped`, 아니면 `sink_unavailable`. 재전송 박자의 결과 차례다).
3. 시작이면 봉투의 `header.request_id`와 `body.run_id`로 `markStartDispatch({ runId, requestId, now: at })`를 부른다. `{ ok: true, created: boolean }`만 `ok`다(`created: false`, 같은 열기에서 이미 적은 표식도 `ok`). 거절이면 그 이름, 던지면 `threw`, 다른 꼴이면 `malformed_answer`, 봉투에서 두 ID를 읽지 못하면 `envelope_unreadable`이고 모두 싣지 않는다.
4. 시작이면 `lastCheck`. 재전송 박자는 여기서 시계를 다시 읽어 발행 + 19000ms 한도를 본다. 표식의 커밋(fsync)에 걸린 시간을 이 읽기가 잰다.
5. 2에서 얻은 함수를 수신 객체를 `this`로 해 부른다(`Reflect.apply`). 1~4는 동기라 **표식·마지막 확인과 포트 호출 사이에 `await`가 없다**(첫 `await`가 포트 호출이다. 정적 시험이 본다).

취소·확정·갱신 같은 시작이 아닌 봉투는 2와 5만 한다. 표식을 부르지 않고 `start`를 보지 않는다.

## 표식 뒤에 싣지 않고 돌아가는 길

표식을 커밋한 뒤 싣지 못한 것은 안전한 쪽이다: 그 실행은 다른 열기에서 자동으로 닫히지 않는다(`sent_by_other_open`, 손 닫기로 간다). 같은 열기에서는 표식이 닫기를 막지 않지만, 그때 닫는 근거는 실행기의 전체 답이 그 실행을 싣지 않았다는 것이라 실제로 싣지 않은 시작과 어긋나지 않는다. 표식은 포트 호출 직전에 두어 이 길을 줄였고, 남는 길은 아래뿐이다.

- **재전송 시작의 마지막 시계 읽기가 막을 때.** 표식 커밋 중이나 그 뒤에 발행 + 19000ms를 넘었거나(`start_expired`) 시계를 읽지 못했다(`withheld`/`clock_unavailable`). 순서상 표식이 시계 읽기보다 앞이어야 하므로(커밋 시간을 재야 한다) 이 길은 없앨 수 없다.
- **포트가 싣지 않았다고 답할 때**(`no_connection`·`too_late_to_send`).
- **포트가 던지거나 정의 밖의 값을 돌려줄 때**(`delivery: "unknown"`). 실렸을 수 있다.
- **표식 커밋 뒤 포트 호출 전에 프로세스가 죽을 때.**

배정·시작 박자는 표식을 봉한 뒤에 부르므로, 초안·봉하기의 실패(`draft_threw`, `seal_threw`, 거절 이름)와 장부의 시작 거절에는 표식이 없다.

## 정적 시험 (`test/supervisor/dispatch/start-send.test.ts`)

**보는 것.** `src/`의 모든 `.ts`(줄 전체 주석은 뺀다)에서 송신처럼 보이는 자리를 모양별로 센다: 메서드 호출 `.send(`, 속성 읽기 `.send`, 꺼낸 함수의 호출 `send(`(메서드 선언은 뺀다), `Reflect.apply(`, 문자열 이름 접근 `["send"]`, `send`를 꺼내는 구조 분해. 그 목록이 정한 목록과 같아야 한다(이 파일의 두 자리, 취소·수명 박자, 실행기 → 감독 연결). 그리고:

- `startDraft`를 부르는 모듈은 배정·시작 박자와 재전송 박자뿐이고, 둘에는 송신 자리가 없고 `sendInstruction`을 정확히 한 번 부른다.
- `task_start`를 문자열로 쓰는 감독 모듈은 봉투 모듈·재전송 박자·이 파일뿐이다. 감독에서 서명 포트(`.seal(`)나 계약의 `sealEnvelope`를 부르는 자리는 봉투 모듈과 정지 동기화의 답(`stop_sync_reply`만 받는 포트)뿐이다.
- 이 파일 밖의 송신 자리가 있는 모듈은 `startDraft`를 부르지 않고 `task_start` 문자열이 없다. 실행기 모듈은 감독 모듈을 import하지 않는다.
- `markStartDispatch`를 부르는 곳(장부 밖)은 이 파일뿐이고, 이 함수 안의 차례는 포트 얻기 → 표식 → 마지막 확인 → 포트 호출, 첫 `await`가 포트 호출이다.

**보지 못하는 것.** 실행 중에 만든 이름(`sink["se" + "nd"]`), 다른 이름의 메서드로 감싼 포트를 넘겨받아 부르는 함수, `Function.prototype.call.call` 같은 간접 호출, `eval`·`new Function`, `task_start`를 실행 중에 조립한 초안, `src/` 밖의 코드, 아직 없는 조립·전송 구현(예: 연결 처리기의 `send_reply` 출력을 실제로 쓰는 쪽). 실행기가 자기 키로 봉한 봉투는 감독의 시작으로 받아들여지지 않는다는 계약의 방향 규칙에 기대고, 그것을 이 시험이 보지는 않는다. 함수가 봉투의 동작으로 시작을 가르는지는 행동 시험이 본다.

새 송신 자리를 더하면 목록 시험이 먼저 실패한다. 그때 그 자리가 시작 봉투를 받을 수 있으면 이 함수를 지나게 하고, 아니면 목록과 "시작 봉투를 만들 수 없음"의 근거를 함께 고친다.

## 뒤 조각이 지킬 것

- **조립이 넘기는 장부 포트는 박자가 읽고 쓰는 그 장부 객체다.** 표식은 장부 열기마다 따로 센다. 박자의 `ledger` 포트에 표식을 함께 싣는 것도 이 때문이다(`startRun`·다시 읽기와 같은 객체로 적는다). 다른 열기의 객체를 넘기면 이 열기에서 실은 시작을 장부가 가리지 못한다.
- **내보내기 포트는 받은 봉투를 지속 저장했다가 재기동 뒤에 싣지 않는다.** 그러면 새 열기의 표식 없이 시작이 실린다. 메모리의 대기는 프로세스와 함께 사라지므로 괜찮다.
- **내보내기 포트가 싣는 순간에 지킬 것은 그대로다**(`ports.ts` `InstructionSink`, 두 박자의 문서): 정지 세대, 봉투 시한, 시작의 작업 기한 여유, 맡기지 않을 실행기.
- **시작 봉투를 내는 새 길은 이 함수를 지난다.** 세션 시작(`session_start`)을 여는 작업은 같은 표식 규칙이 필요한지 장부와 함께 정한다(지금 이 함수는 `task_start`만 표식을 요구한다).
