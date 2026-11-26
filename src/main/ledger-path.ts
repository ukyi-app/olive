// 감독 장부의 자리. 감독 진입점과 장부 초기화 진입점이 같은 값을 쓴다: 둘이 갈라지면 초기화가 만든 장부를 감독이 보지 못하고
// 빈 볼륨으로 보아 94로 끝난다. 폴더는 환경이 주고 파일 이름은 코드가 정한다.
export const LEDGER_DIR_ENV = "OLIVE_LEDGER_DIR";
export const LEDGER_FILE = "supervisor.db";
