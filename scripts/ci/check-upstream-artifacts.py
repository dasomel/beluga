#!/usr/bin/env python3
"""#103: 업스트림 아티팩트 검증 우회를 오프라인에서 차단한다 (stdlib 전용, 네트워크 없음).

1) configs/upstream-artifacts.sha256 형식(64 hex + https URL, 중복 금지)
2) scripts/ 아래 셸이 원격 내용을 검증 없이 실행/적용(kubectl -f URL, curl | sh|kubectl)하지 않음
3) fetch_verified 리터럴 URL이 모두 잠금 파일에 존재
4) scripts/common/verified-fetch.sh의 fail-closed 동작을 file:// URL로 실측(음성 fixture)

D1: 아직 미고정인 설치 스크립트는 사유가 있는 UNVERIFIED_ALLOWLIST로만 허용한다. 비용은 항목이
늘면 리뷰에서 보인다는 점이며, 탈출구는 해당 줄을 fetch_verified로 바꾸고 항목을 지우는 것이다.
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
LOCK = REPO_ROOT / "configs" / "upstream-artifacts.sha256"
HELPER = REPO_ROOT / "scripts" / "common" / "verified-fetch.sh"
SHA = re.compile(r"[0-9a-f]{64}")
URL = re.compile(r"https://[^\s\"']+")
# 가변 참조(브랜치/별칭)로 읽는 URL은 해시가 맞아도 재현 불가하므로 태그/커밋만 허용한다.
MUTABLE_REF = re.compile(r"/(?:main|master|HEAD|latest|stable|release-[^/]*)/|/releases/latest/")
REMOTE_APPLY = re.compile(r"\bkubectl\b[^\n]*\s-f\s+\"?https?://")
PIPE_EXEC = re.compile(r"\bcurl\b[^\n]*\|\s*(?:\w+=\S+\s+)*(?:ba)?sh\b|\bcurl\b[^\n]*\|\s*(?:sed\b[^|]*\|\s*)?kubectl\b")
# (저장소 상대 경로, 호출 URL 부분 문자열): 사유. #103 후속 단계에서 제거 대상.
UNVERIFIED_ALLOWLIST = {
    ("scripts/cluster/02-k8s-init.sh", "https://get.k3s.io"):
        "k3s 설치 스크립트는 채널 기반 가변 콘텐츠 — 릴리스 바이너리 해시 고정은 후속 단계",
    ("scripts/cluster/03-cni-metallb.sh", "get-helm-3"):
        "Helm 설치 스크립트(main 브랜치) — 릴리스 tarball 해시 고정은 후속 단계",
}


def load_lock(path: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 2 or not SHA.fullmatch(parts[0]) or not parts[1].startswith("https://"):
            raise ValueError(f"{path}:{number}: expected '<64 hex sha256>  https://<url>'")
        if MUTABLE_REF.search(parts[1]):
            raise ValueError(f"{path}:{number}: mutable ref (branch/latest) in pinned URL: {parts[1]}")
        if parts[1] in entries:
            raise ValueError(f"{path}:{number}: duplicate entry for {parts[1]}")
        entries[parts[1]] = parts[0]
    if not entries:
        raise ValueError(f"{path}: empty lock file")
    return entries


def scan_script(rel: str, text: str, lock: dict[str, str]) -> list[str]:
    errors = []
    for number, line in enumerate(text.splitlines(), 1):
        code = line.split("#", 1)[0] if line.lstrip().startswith("#") else line
        if "fetch_verified" in code:
            for url in URL.findall(code):
                if url not in lock:
                    errors.append(f"{rel}:{number}: fetch_verified URL not pinned in lock: {url}")
            continue
        if REMOTE_APPLY.search(code) or PIPE_EXEC.search(code):
            allowed = any(r == rel and frag in code for (r, frag) in UNVERIFIED_ALLOWLIST)
            if not allowed:
                errors.append(f"{rel}:{number}: unverified remote artifact use (use fetch_verified): {code.strip()}")
    return errors


def scan_repo(lock: dict[str, str]) -> list[str]:
    errors = []
    for path in sorted((REPO_ROOT / "scripts").rglob("*.sh")):
        errors += scan_script(str(path.relative_to(REPO_ROOT)), path.read_text(encoding="utf-8"), lock)
    return errors


def run_helper(lock_text: str | None, url: str, dest: Path) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory() as tmp:
        lock = Path(tmp) / "lock"
        if lock_text is not None:
            lock.write_text(lock_text, encoding="utf-8")
        return subprocess.run(
            ["bash", "-c", f'source "{HELPER}"; fetch_verified "$1" "$2"', "_", url, str(dest)],
            env={"PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", "UPSTREAM_LOCK_FILE": str(lock),
                 "VERIFIED_FETCH_PROTO": "=file" if url.startswith("file:") else "=https"},
            capture_output=True, text=True,
        )


def self_test() -> None:
    import hashlib
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "artifact.yaml"
        src.write_bytes(b"kind: Example\n")
        good = hashlib.sha256(src.read_bytes()).hexdigest()
        url = src.as_uri()
        dest = Path(tmp) / "out.yaml"
        # file:// 은 https 계약 밖이라 helper 단위 테스트에서만 쓴다.
        cases = [
            ("valid pin passes", f"{good}  {url}\n", 0, True),
            ("missing lock entry fails closed", f"{good}  file:///other\n", 1, False),
            ("absent lock file fails closed", None, 1, False),
            ("hash mismatch fails closed and removes file", f"{'0' * 64}  {url}\n", 1, False),
            ("malformed hash fails closed", f"abc123  {url}\n", 1, False),
            ("duplicate entries fail closed", f"{good}  {url}\n{good}  {url}\n", 1, False),
            ("extra field fails closed", f"{good}  {url}  extra\n", 1, False),
            ("malformed unrelated line fails closed", f"{good}  {url}\ngarbage\n", 1, False),
        ]
        for name, lock_text, want_rc, want_file in cases:
            dest.unlink(missing_ok=True)
            result = run_helper(lock_text, url, dest)
            if result.returncode != want_rc or dest.exists() != want_file:
                raise AssertionError(f"self-test '{name}': rc={result.returncode} file={dest.exists()} {result.stderr.strip()}")
        dest.unlink(missing_ok=True)
        if [p for p in Path(tmp).iterdir() if p.name.startswith("out.yaml.")]:
            raise AssertionError("self-test: temp file left behind")
        # 운영 설정(https 전용)에서는 file:// 가 거부돼야 한다.
        proto = subprocess.run(
            ["bash", "-c", f'source "{HELPER}"; fetch_verified "$1" "$2"', "_", url, str(dest)],
            env={"PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", "UPSTREAM_LOCK_FILE": str(Path(tmp) / "plock")},
            capture_output=True, text=True)
        if proto.returncode == 0 or dest.exists():
            raise AssertionError("self-test: helper accepted non-https default")
        (Path(tmp) / "plock").write_text(f"{good}  {url}\n", encoding="utf-8")
        proto = subprocess.run(
            ["bash", "-c", f'source "{HELPER}"; fetch_verified "$1" "$2"', "_", url, str(dest)],
            env={"PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", "UPSTREAM_LOCK_FILE": str(Path(tmp) / "plock")},
            capture_output=True, text=True)
        if proto.returncode == 0 or dest.exists():
            raise AssertionError("self-test: file:// accepted under default https-only proto")
        if run_helper(f"{good}  file:///nonexistent\n", "file:///nonexistent", dest).returncode == 0:
            raise AssertionError("self-test 'download failure fails closed'")

    lock = {"https://example.com/ok.yaml": "a" * 64}
    negatives = {
        "kubectl apply from URL": "kubectl apply -f https://example.com/x.yaml\n",
        "curl piped to kubectl": "curl -sL https://example.com/x.yaml | kubectl apply -f -\n",
        "curl piped to bash": "curl -sfL https://example.com/i.sh | bash\n",
        "curl piped to env-prefixed sh": "curl -sfL https://example.com/i | FOO=1 sh -\n",
        "unpinned fetch_verified": "fetch_verified https://example.com/new.yaml /tmp/x\n",
    }
    for name, text in negatives.items():
        if not scan_script("scripts/x.sh", text, lock):
            raise AssertionError(f"self-test '{name}' was not rejected")
    if scan_script("scripts/x.sh", "fetch_verified https://example.com/ok.yaml /tmp/x\n", lock):
        raise AssertionError("self-test: pinned fetch_verified was rejected")
    for bad in ("deadbeef  https://x\n", f"{'a' * 64}  http://x\n", "",
                f"{'a' * 64}  https://h/o/r/main/x.yaml\n", f"{'a' * 64}  https://h/o/r/release-1.30/x.yaml\n",
                f"{'a' * 64}  https://h/o/r/releases/latest/x.yaml\n"):
        with tempfile.NamedTemporaryFile("w", suffix=".lock", delete=False) as handle:
            handle.write(bad)
        try:
            load_lock(Path(handle.name))
        except ValueError:
            continue
        finally:
            Path(handle.name).unlink()
        raise AssertionError(f"self-test: bad lock accepted: {bad!r}")


def main() -> int:
    try:
        lock = load_lock(LOCK)
        errors = scan_repo(lock)
        if errors:
            print("\n".join(errors), file=sys.stderr)
            return 1
        self_test()
    except (ValueError, AssertionError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(f"upstream artifact gate OK: {len(lock)} pinned artifacts, {len(UNVERIFIED_ALLOWLIST)} allowlisted installer scripts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
