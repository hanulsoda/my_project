"""영상과 요점노트·시험대비의 연결 현황: python -m academy.study_links

영상 폴더의 강의마다 어떤 자료에 연결되는지 세어, 번호로만 맞았거나 모호하거나 연결되지 않은 영상을 보여 줍니다.
아무것도 바꾸지 않습니다. 서버·점검과 같은 설정 파일을 읽습니다.
"""

import os
import sys
from pathlib import Path

from academy.library import find_videos
from academy.settings import load_env_file
from academy.study import NO_GRADE, lacks_grade, link_video, read_links, read_study, usable_study

UNLINKED_SHOWN = 50


def report(videos: list[dict], entries: list[dict], links: dict | None = None) -> list[str]:
    """첫 줄에 종류별 영상 수, 이어서 확인이 필요한 영상 줄(연결 안 됨은 최대 50개)."""
    counts = dict.fromkeys(("matched", "direct", "number_only", "ambiguous", "none"), 0)
    number_only, ambiguous, unlinked, linked_ids = [], [], [], set()
    for video in videos:
        result = link_video(entries, video["title"], links)
        counts[result["status"]] += 1
        linked_ids.update(e["id"] for e in result["entries"])
        if result["status"] == "number_only":
            number_only.append(f"[번호로만 연결] {video['title']} → {result['entries'][0]['id']}")
        elif result["status"] == "ambiguous":  # 모호하면 항목을 돌려주지 않으므로 항목마다 따로 맞혀 봅니다
            ids = [e["id"] for e in entries if link_video([e], video["title"])["status"] != "none"]
            ambiguous.append(f"[모호함] {video['title']} → {', '.join(ids)}")
        elif result["status"] == "none":
            unlinked.append(f"[연결 안 됨] {video['title']}")
    lines = [f"연결됨 {counts['matched']}개 · 번호로만 연결 {counts['number_only']}개 · 직접 연결 {counts['direct']}개"
             f" · 모호함 {counts['ambiguous']}개 · 연결 안 됨 {counts['none']}개"]
    lines += number_only + ambiguous + unlinked[:UNLINKED_SHOWN]
    if len(unlinked) > UNLINKED_SHOWN:
        lines.append(f"… 외 {len(unlinked) - UNLINKED_SHOWN}개")
    lines += [f"[학년 미확인] 항목 {e['id']}: {NO_GRADE}" for e in entries if e["id"] in linked_ids and lacks_grade(e)]
    return lines


def main(env=os.environ) -> int:
    try:
        load_env_file(env)
        video_dir = Path(env.get("VIDEO_DIR", "videos"))
        entries = usable_study(read_study(env.get("STUDY_FILE")))
        links = read_links(env.get("STUDY_LINKS_FILE"))
    except SystemExit as e:  # 설정을 읽지 못해도 보고는 안내 한 줄로 끝냅니다
        print(e)
        return 0
    if not video_dir.is_dir():
        print(f"영상 폴더가 없습니다: {video_dir.resolve()} (VIDEO_DIR, NAS 연결 확인)")
        return 0
    if not entries:
        print("시험대비 자료가 없습니다. STUDY_FILE을 설정했는지 확인하세요(python -m academy.check)")
        return 0
    print("\n".join(report(find_videos(video_dir), entries, links)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
