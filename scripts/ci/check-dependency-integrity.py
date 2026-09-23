#!/usr/bin/env python3
"""#103: CI 의존성 고정과 해시 강제 옵션의 회귀를 오프라인에서 차단한다.

실제 아티팩트의 해시 비교는 CI의 pip가 수행한다. 이 검사는 requirements와
설치 명령의 정적 계약 및 음성 fixture만 검증하며 패키지를 내려받지 않는다.

알려진 제약(Low, #103 리뷰): `-r <file>` 인자는 항상 저장소 루트 기준으로
해석된다. 실제 셸에서는 `cd`/`pushd`나 Makefile 레시피의 실행 디렉터리, GitHub
Actions의 `working-directory:`에 따라 상대 경로 기준이 달라질 수 있는데, 이
정적 검사는 각 호출 파일이 실행되는 셸의 작업 디렉터리를 추적하지 않는다(그
추적 자체가 이 검사의 오프라인·stdlib 전용 범위를 벗어나는 작업이다). 현재
저장소의 모든 호출은 저장소 루트에서 실행되므로 오탐/누락이 없지만, 저장소
루트가 아닌 위치에서 상대 `-r` 경로를 사용하는 새 호출을 추가할 경우 이 검사가
잘못된 경로를 검증하거나 "파일이 존재하지 않음"으로 오탐할 수 있다. 새 호출은
저장소 루트 기준 상대 경로를 쓰거나, 이 문서와 `docs/development.md`의 설명을
갱신해야 한다.
"""
import re
import shlex
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PIN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*==[A-Za-z0-9][A-Za-z0-9.!+_-]*")
HASH = re.compile(r"--hash=sha256:[0-9a-fA-F]{64}")
# 라인 사전 필터: pip/pip3(.버전) 토큰 또는 공백 없는 "-m[ ]pip" 모듈 호출도 잡는다.
PIP = re.compile(r"\bpip3?(?:\.\d+)?\b|-m\s*pip3?(?:\.\d+)?\b")
# 실행 파일 판정: pip, pip3, 버전 접미 실행 파일(pip3.10, pip3.12 등)을 전체 일치로 인정한다.
PIP_EXECUTABLE = re.compile(r"pip3?(?:\.\d+)?")
# "-mpip"처럼 공백 없이 붙은 모듈 호출: python3 -mpip install ... 우회를 닫는다.
MODULE_PIP = re.compile(r"-m(?:pip3?(?:\.\d+)?)")
# 호환 설치 뒤의 셸 리다이렉션(> >> 2>&1 2>/dev/null)은 인자가 아니라 명령 경계다.
REDIRECT = re.compile(r"^\d*>>?")
SEPARATORS = {";", "&&", "||", "|", "&", "(", ")"}
# 예외가 필요하면 (저장소 상대 경로, 전체 명령 토큰): 구체적 사유를 명시한다.
# 파일 전체 예외는 금지한다. 현재 실행 호출은 모두 계약을 만족해 예외가 없다.
INSTALL_ALLOWLIST: dict[tuple[str, tuple[str, ...]], str] = {}


def logical_lines(text: str):
    """역슬래시 줄 연결을 처리하고 오류 위치는 첫 물리 행으로 보존한다."""
    pending = ""
    start = 1
    for number, line in enumerate(text.splitlines(), 1):
        if not pending:
            start = number
        if line.endswith("\\"):
            pending += line[:-1] + " "
            continue
        yield start, pending + line
        pending = ""
    if pending:
        raise ValueError(f"line {start}: unterminated line continuation")


def check_requirements(path: Path) -> int:
    count = 0
    for number, line in logical_lines(path.read_text(encoding="utf-8")):
        # D1: 허용 문법만 열거해 URL/옵션 우회를 닫는다. 비용은 markers/extras 등
        # 미지원 문법의 거부이며, 필요하면 음성 fixture와 함께 문법을 확장한다.
        tokens = re.split(r"\s+#", line, maxsplit=1)[0].split()
        if not tokens or tokens[0].startswith("#"):
            continue
        if not PIN.fullmatch(tokens[0]):
            raise ValueError(f"{path}:{number}: expected an exact name==version pin")
        if len(tokens) < 2 or not all(HASH.fullmatch(token) for token in tokens[1:]):
            raise ValueError(f"{path}:{number}: expected only --hash=sha256:<64 hex> entries")
        count += 1
    if not count:
        raise ValueError(f"{path}: empty requirements file")
    return count


def install_commands(line: str):
    """문자열 안의 리터럴 명령도 검사하되 명령 사이의 옵션을 빌려 쓰지 않는다."""
    lexer = shlex.shlex(line, posix=True, punctuation_chars=";&|()")
    lexer.whitespace_split = True
    tokens = list(lexer)
    for index, token in enumerate(tokens):
        executable = token.rsplit("/", 1)[-1].lstrip("@")
        module_call = MODULE_PIP.fullmatch(executable)
        if PIP_EXECUTABLE.fullmatch(executable) or module_call:
            end = index + 1
            while (end < len(tokens) and tokens[end] not in SEPARATORS
                   and not REDIRECT.match(tokens[end])):
                end += 1
            command = tokens[index:end]
            if module_call:
                # "-mpip"는 실행 파일이 아니라 python의 모듈 호출이다: pip 호출로 정규화한다.
                command = ["pip"] + command[1:]
            if len(command) > 1 and (command[1] == "install" or (
                    command[1].startswith("-") and "install" in command[2:])):
                yield command
        elif PIP.search(token) and any(char.isspace() for char in token):
            # YAML의 따옴표 run 값, shell -c, Python의 명령 문자열도 같은 검사 적용.
            yield from install_commands(token)


def check_install(root: Path, relative: str, command: list[str]) -> None:
    reason = INSTALL_ALLOWLIST.get((relative, tuple(command)))
    if reason and reason.strip():
        return
    if command[1] != "install":
        raise ValueError("unsupported pip global options before install")
    hashed = False
    requirements = []
    arguments = iter(command[2:])
    for argument in arguments:
        if argument == "--require-hashes":
            hashed = True
        elif argument in {"--quiet", "-q"}:
            continue
        elif argument in {"-r", "--requirement"}:
            requirements.append(next(arguments, ""))
        else:
            raise ValueError(f"unapproved install argument: {argument}")
    if not hashed or not requirements:
        raise ValueError("install requires --require-hashes and -r <file>")
    for requirement in requirements:
        if not re.fullmatch(r"[A-Za-z0-9_./-]+", requirement):
            raise ValueError(f"expected a literal local requirements path: {requirement!r}")
        path = (root / requirement).resolve()
        if not path.is_relative_to(root.resolve()) or not path.is_file():
            raise ValueError(f"requirements file must exist inside the repository: {requirement}")
        check_requirements(path)


def check_repository(root: Path) -> tuple[int, int]:
    pinned = check_requirements(root / "requirements-ci.txt")
    paths = [root / "Makefile"]
    workflows = root / ".github/workflows"
    paths.extend(sorted(list(workflows.glob("*.yml")) + list(workflows.glob("*.yaml"))))
    for directory in ("scripts", "tests"):
        paths.extend(sorted(path for path in (root / directory).rglob("*") if path.is_file()))
    installs = 0
    for path in paths:
        # Python bytecode와 macOS 메타데이터는 실행 명령을 담는 소스가 아니다.
        if "__pycache__" in path.parts or path.suffix == ".pyc" or path.name == ".DS_Store":
            continue
        for number, line in logical_lines(path.read_text(encoding="utf-8")):
            if not PIP.search(line) or line.lstrip().startswith("#"):
                continue
            try:
                for command in install_commands(line):
                    check_install(root, path.relative_to(root).as_posix(), command)
                    installs += 1
            except ValueError as error:
                raise ValueError(f"{path}:{number}: {error}") from error
    return pinned, installs


def self_test() -> None:
    # D2: 검사 본문을 공유하는 임시 저장소에 변조를 주입한다. 네트워크 비용 없이
    # 감지기의 fail-open 회귀를 잡으며, 실제 wheel 바이트 검증은 CI의 pip에 맡긴다.
    continuation = " \\" + "\n"
    good = "demo==1.2.3" + continuation + "    --hash=sha256:" + "a" * 64 + "\n"
    install = " ".join(["pip", "install"])
    safe = install + " --quiet --require-hashes -r requirements-ci.txt"
    cases = [
        ("missing hash", "demo==1.2.3\n", safe, "--hash=sha256"),
        ("unpinned >=", good.replace("==", ">="), safe, "exact name==version"),
        ("substituted index URL", "--index-url https://substitute.invalid/simple\n" + good,
         safe, "exact name==version"),
        ("install without --require-hashes", good, safe.replace(" --require-hashes", ""),
         "requires --require-hashes"),
        ("pip3 without --require-hashes", good,
         safe.replace("pip ", "pip3 ").replace(" --require-hashes", ""),
         "requires --require-hashes"),
        ("pip3.12 without --require-hashes", good,
         safe.replace("pip ", "pip3.12 ").replace(" --require-hashes", ""),
         "requires --require-hashes"),
        ("python3.12 -m pip without --require-hashes", good,
         safe.replace("pip ", "python3.12 -m pip ").replace(" --require-hashes", ""),
         "requires --require-hashes"),
        ("python3 -mpip (no space) without --require-hashes", good,
         safe.replace("pip ", "python3 -mpip ").replace(" --require-hashes", ""),
         "requires --require-hashes"),
        ("redirected install without --require-hashes", good,
         safe.replace(" --require-hashes", "") + " > log", "requires --require-hashes"),
        ("quoted install without --require-hashes", good,
         '"' + safe.replace(" --require-hashes", "") + '"', "requires --require-hashes"),
        ("missing -r", good, install + " --require-hashes", "requires --require-hashes"),
        ("malformed hash", good.replace("a" * 64, "a" * 63), safe, "--hash=sha256"),
        ("URL requirement", good.replace("demo==1.2.3", "https://substitute.invalid/demo.whl"),
         safe, "exact name==version"),
        ("VCS requirement", good.replace("demo==1.2.3", "git+https://substitute.invalid/demo"),
         safe, "exact name==version"),
        ("editable requirement", "-e .\n" + good, safe, "exact name==version"),
        ("extra index override", "--extra-index-url https://substitute.invalid\n" + good,
         safe, "exact name==version"),
        ("trusted host override", "--trusted-host substitute.invalid\n" + good,
         safe, "exact name==version"),
        ("install index override", good, safe + " --index-url https://substitute.invalid",
         "unapproved install argument"),
        ("flags on another command", good, install + " demo; " + safe,
         "unapproved install argument"),
        ("hash only in comment", "demo==1.2.3 # --hash=sha256:" + "a" * 64,
         safe, "--hash=sha256"),
        ("flags only in comment", good, install + " # --require-hashes -r requirements-ci.txt",
         "requires --require-hashes"),
        ("missing requirements file", good, safe.replace("requirements-ci.txt", "missing.txt"),
         "must exist inside the repository"),
    ]
    with tempfile.TemporaryDirectory(prefix="beluga-dependency-gate-") as temporary:
        root = Path(temporary)
        (root / ".github/workflows").mkdir(parents=True)
        (root / "scripts").mkdir()
        (root / "tests").mkdir()
        source_paths = (".github/workflows/ci.yml", ".github/workflows/ci.yaml",
                         "Makefile", "scripts/install.sh", "tests/install.sh")
        valid_commands = (
            safe,
            safe.replace("pip ", "pip3 "),
            safe.replace("pip ", "pip3.12 "),
            safe.replace("pip ", "/usr/bin/pip3 "),
            safe.replace("pip ", "python3.12 -m pip "),
            safe.replace("pip ", "python3 -mpip "),
            '"' + safe + '"',
            safe.replace(" --require-hashes", continuation + "  --require-hashes"),
            safe + " > log",
            safe + " >> log",
            safe + " 2>&1",
            safe + " 2>/dev/null",
            safe + " | tee log",
        )

        def fixture(requirements: str, source: str, command: str) -> None:
            (root / "requirements-ci.txt").write_text(requirements, encoding="utf-8")
            for relative in source_paths:
                (root / relative).write_text("", encoding="utf-8")
            prefix = "run: " if source.endswith((".yml", ".yaml")) else ""
            (root / source).write_text(prefix + command + "\n", encoding="utf-8")

        for source in source_paths:
            for command in valid_commands:
                fixture(good, source, command)
                if check_repository(root) != (1, 1):
                    raise ValueError(f"self-test did not find valid install: {source}: {command}")
            for name, requirements, command, diagnostic in cases:
                fixture(requirements, source, command)
                try:
                    check_repository(root)
                except ValueError as error:
                    if diagnostic not in str(error):
                        raise ValueError(f"self-test {name}: unexpected failure: {error}") from error
                else:
                    raise ValueError(f"self-test accepted {name}: {source}")
    print(f"Self-tests OK: {len(valid_commands) * len(source_paths)} valid fixtures; "
          f"{len(cases) * len(source_paths)} substitutions rejected")


def main() -> int:
    try:
        self_test()
        pinned, installs = check_repository(REPO_ROOT)
    except (OSError, UnicodeError, ValueError) as error:
        print(f"Dependency integrity FAIL: {error}", file=sys.stderr)
        return 1
    print(f"Dependency integrity OK: {pinned} pinned requirements; {installs} protected installs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
