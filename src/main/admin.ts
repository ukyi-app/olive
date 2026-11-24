// 감독 관리 진입점(D-60). homelab CLI가 감독 컨테이너에서 kubectl exec로 `bun src/main/admin.ts status`를 부른다(그 CLI의 고정 argv).
// 감독 프로세스의 관리 소켓에 붙어 답 한 줄을 받는다. 알려진 상태면 stdout에 상태 JSON 한 줄을 쓰고 0, 그 밖은 stderr 한 줄과
// 0이 아닌 코드다(src/supervisor/admin/client.ts의 ADMIN_EXIT, README "감독 관리 통로").
// 환경을 읽지 않고 듣지 않으며 장부를 열지 않는다. 소켓 경로는 감독과 같은 고정 값이다(protocol.ts).
import { ask, type ClientDeps, commandOf, exitFor, USAGE } from "../supervisor/admin/client.ts";

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
  const command = commandOf(process.argv.slice(2));
  const result = command === null ? USAGE : exitFor(await ask(command, deps));
  // 출력을 다 쓴 뒤에 끝낸다(파이프에 쓰는 도중 exit로 잘리지 않게).
  if (result.stdout !== "") await Bun.write(Bun.stdout, result.stdout);
  if (result.stderr !== "") await Bun.write(Bun.stderr, result.stderr);
  process.exit(result.code);
}

if (import.meta.main) await main();
