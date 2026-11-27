"""선생님이 승인한 초안 항목만 STUDY_FILE(학생에게 보이는 자료)로 모읍니다.

사용: 저장소 맨 위 폴더에서(`academy`를 import할 수 있어야 합니다)
    python tools/study/promote.py <초안.json> <STUDY_FILE.json> <항목 id>...
출력 파일이 이미 있으면 합치고, id가 같은 항목은 새것으로 바꿉니다.
없는 id나 모양이 틀린 항목이 있으면 아무것도 쓰지 않고 멈춥니다.
"""

import json
import os
import sys
import tempfile
from pathlib import Path


def promote(draft_path: str, out_path: str, ids: list[str]) -> list[str]:
    """초안에서 ids의 항목만 out_path에 써 넣고, 쓴 id를 돌려줍니다."""
    from academy.study import entry_problems, read_study

    draft = read_study(draft_path)
    by_id = {e["id"]: e for e in draft if isinstance(e, dict) and isinstance(e.get("id"), str)}
    ids = list(dict.fromkeys(ids))
    if not ids:
        raise SystemExit("승인할 항목 id를 하나 이상 알려 주세요")
    missing = [i for i in ids if i not in by_id]
    if missing:
        raise SystemExit(f"초안에 없는 항목 id입니다(아무것도 쓰지 않았습니다): {', '.join(missing)}")
    for i in ids:
        problems = entry_problems(by_id[i])
        if problems:
            raise SystemExit(f"항목 {i!r}의 모양이 틀려 쓰지 않았습니다: {'; '.join(problems[:3])}")
    out = Path(out_path).expanduser()
    existing = read_study(out) if out.exists() else []
    chosen = {i: by_id[i] for i in ids}
    merged = [chosen.pop(e["id"], e) if isinstance(e, dict) and e.get("id") in chosen else e for e in existing]
    merged += chosen.values()
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=out.parent, prefix=out.name + ".", suffix=".tmp")  # 같은 폴더에 써 두었다가 바꿔치기
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(merged, ensure_ascii=False, indent=2) + "\n")
        os.replace(tmp, out)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return ids


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("사용: python tools/study/promote.py <초안.json> <출력.json> <항목 id>...", file=sys.stderr)
        return 2
    print("승격함:", ", ".join(promote(argv[0], argv[1], argv[2:])))
    return 0


if __name__ == "__main__":
    # 직접 실행하면 이 폴더가 import 경로가 되므로, academy를 찾도록 저장소 맨 위 폴더를 더합니다(명령줄 실행에서만)
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    sys.exit(main(sys.argv[1:]))
