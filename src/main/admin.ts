// 감독 관리 진입점(D-60). homelab CLI가 감독 컨테이너에서 kubectl exec로 `bun src/main/admin.ts status`를 부른다(그 CLI의 고정 argv).
// 시험 클러스터에서는 `bun src/main/admin.ts test-job <owner> <key> <role> <purpose> <sourceRef> <inputDigest>`로 시험 작업을 넣는다(D-98·D-101,
// 감독이 켜 둔 때만 받는다). 자리 풀기(D-149 ④)는 `holds`(읽기)와 쓰기 넷(`close-unconfirmed`·`abandon-result`·`close-store-reset`·
// `release-hold`)이다(README "감독 관리 통로"의 "자리 풀기"). 감독 프로세스의 관리 소켓에 붙어 답 한 줄을 받는다. 알려진 답이면 stdout에 JSON 한 줄을 쓰고 0, 그 밖은
// stderr 한 줄과 0이 아닌 코드다(src/supervisor/admin/client.ts의 ADMIN_EXIT, README "감독 관리 통로").
// 환경을 읽지 않고 듣지 않으며 장부를 열지 않는다. 소켓 경로는 감독과 같은 고정 값이다(protocol.ts).
import { ask, type ClientDeps, exitFor, requestOf, USAGE } from "../supervisor/admin/client.ts";

const deps: ClientDeps = {
  connect: (path, handlers) =>
    Bun.connect({
      unix: path,
      socket: {
        data: (_socket, chunk) => handlers.data(chunk),
        close: () => handlers.close(),
        error: () => handlers.close(),
      },
    }),
  monoNow: () => performance.now(),
  setTimer: (ms, fire) => {
    const handle = setTimeout(fire, ms);
    return () => clearTimeout(handle);
  },
};

async function main(): Promise<never> {
  const call = requestOf(process.argv.slice(2));
  const result = call === null ? USAGE : exitFor(await ask(call, deps), call);
  // 출력을 다 쓴 뒤에 끝낸다(파이프에 쓰는 도중 exit로 잘리지 않게).
  if (result.stdout !== "") await Bun.write(Bun.stdout, result.stdout);
  if (result.stderr !== "") await Bun.write(Bun.stderr, result.stderr);
  process.exit(result.code);
}

if (import.meta.main) await main();
