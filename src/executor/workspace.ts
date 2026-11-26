// 역할 컨테이너의 실행 작업 공간(D-154). 루트(/tmp) 전체가 한 실행의 것이다: 대리는 띄우기 전에 비었는지 보고, 정리 때 전부 비운 뒤 다시 센다.
// 대리 코드(src/agent/)는 node:fs를 쓰지 않는다(test/agent/static.test.ts). 그래서 파일 작업은 이 모듈에 두고 AgentParts로 주입한다.
//
// 함정:
// - 루트는 마운트 지점(emptyDir)이라 지우지 않고 그 아래만 지운다.
// - 심볼릭 링크는 따라가지 않고 링크 자신만 지운다(lstat로 본다). 루트 밖의 파일에 닿지 않는다.
// - 같은 uid가 권한을 뺀 폴더는 모드를 되돌린 뒤 연다. 되돌리지 못한 항목은 남고, 남은 수로 센다.
// - 지우는 동안 쓰는 프로세스가 없어야 한다. 부르는 쪽(대리)이 남은 프로세스 0을 본 뒤에만 부른다.
// - 경로로 지운다. 경로가 PATH_MAX를 넘는 깊은 트리는 그 자리가 남아 0이 나오지 않는다(영수증이 나가지 않는 쪽).
// - 이름은 바이트로 읽고 바이트로 이어 붙인다. Linux 파일명은 바이트열이라 UTF-8이 아닌 이름(다른 인코딩의 아카이브)을
//   문자열로 읽으면 바뀐 이름으로 지우려다 실패하고 원래 항목이 계속 남는다(재시도해도 같아 슬롯이 풀리지 않는다).
import { chmod, lstat, mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { posix } from "node:path";

// 역할 컨테이너에서 쓸 수 있는 볼륨은 이 자리의 role-tmp 하나다. 차트와 CI 경계 표가 이 경로를 고정한다.
export const WORKSPACE_ROOT = "/tmp";

export interface RunWorkspace {
  // 루트 바로 아래 항목 수. 읽지 못하면 던진다.
  entries(): Promise<number>;
  // 루트 아래를 모두 지우고 루트 바로 아래 남은 항목 수를 센다. 지우다 실패한 항목은 건너뛰고 끝까지 지운다. 세지 못하면 던진다.
  clear(): Promise<number>;
  // cwd가 루트 아래의 하위 폴더면 (중간 폴더까지) 0700으로 만든다. 루트 자신이거나 루트 밖이면 아무것도 하지 않는다. 만들지 못하면 던진다.
  enter(cwd: string): Promise<void>;
}

// path가 root 자신이거나 그 아래인가. ".."·"."·겹친 "/"가 든 경로는 정규형이 아니라 거절한다(문자열 앞부분만 보고 루트 밖으로 나가지 않게).
export function insideWorkspace(path: string, root: string = WORKSPACE_ROOT): boolean {
  if (!path.startsWith("/") || path.includes("\0") || posix.normalize(path) !== path) return false;
  return path === root || path.startsWith(`${root}/`);
}

export function rootWorkspace(root: string = WORKSPACE_ROOT): RunWorkspace {
  return {
    entries: async () => (await names(Buffer.from(root))).length,
    clear: async () => {
      const top = Buffer.from(root);
      for (const name of await names(top)) await removeTree(child(top, name)).catch(() => {});
      return (await names(top)).length;
    },
    enter: async (cwd) => {
      if (cwd === root || !insideWorkspace(cwd, root)) return;
      await mkdir(cwd, { recursive: true, mode: 0o700 });
    },
  };
}

const names = (dir: Buffer) => readdir(dir, { encoding: "buffer" });

const SLASH = Buffer.from("/");
const child = (dir: Buffer, name: Buffer) => Buffer.concat([dir, SLASH, name]);

async function removeTree(path: Buffer): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory()) return unlink(path);
  if ((info.mode & 0o700) !== 0o700) await chmod(path, 0o700);
  for (const name of await names(path)) await removeTree(child(path, name)).catch(() => {});
  await rmdir(path);
}
