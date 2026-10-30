"""강의 화면에 띄운 교재·판서 글자를 읽어 요점 정리의 근거로 씁니다.

선생님이 페이지를 넘기기 전에 판서를 지우므로, 페이지가 떠 있는 동안 1분마다 읽어 합칩니다.
글자 인식(PaddleOCR)은 용량이 커서 선택 설치입니다(requirements-ocr.txt).
"""

import importlib.util

import av

FIRST = 20  # 페이지가 뜨고 이만큼 지난 뒤부터 읽음(넘기는 중인 화면을 피함)
EVERY = 60


def screen_times(start, end):
    """페이지(start~end초)에서 화면을 읽을 시점들. 짧은 페이지도 한 번은 읽습니다."""
    count = max(0, int((end - start - FIRST) // EVERY)) + 1
    return [min(start + FIRST + EVERY * k, end - 1) for k in range(count)]


def read_screens(video_path, pages, duration, ocr):
    """페이지마다 화면 글자 줄 목록을 돌려줍니다. ocr(화면 배열)은 위에서 아래 순서의 글자 줄을 돌려줍니다."""
    starts = [p["start"] for p in pages] + [duration]
    texts = []
    with av.open(str(video_path)) as container:
        stream = container.streams.video[0]
        for start, end in zip(starts, starts[1:]):
            seen, lines = set(), []
            for t in screen_times(start, end):
                for line in ocr(_frame_at(container, stream, t)):
                    line = line.strip()
                    if len(line) > 2 and line not in seen:  # 메뉴·아이콘 같은 짧은 조각은 버림
                        seen.add(line)
                        lines.append(line)
            texts.append(lines)
    return texts


def _frame_at(container, stream, t):
    # 페이지 시각은 영상 시작을 0초로 센 값이라, 잘라 낸 녹화(첫 화면 시각이 0이 아님)는 그만큼 더해 찾습니다.
    t += float(stream.start_time * stream.time_base) if stream.start_time else 0.0
    container.seek(int(t / stream.time_base), stream=stream)  # t 앞의 키프레임으로 간 뒤 t까지 풀어 냄
    frame = None
    for frame in container.decode(stream):
        if frame.time is not None and frame.time >= t:
            break
    return frame.to_ndarray(format="bgr24")


def paddle_ocr():
    """PaddleOCR(한국어)가 설치돼 있으면 ocr 함수를, 없으면 None을 돌려줍니다. 엔진은 처음 쓸 때 불러옵니다."""
    if importlib.util.find_spec("paddleocr") is None:
        return None
    engine = None

    def ocr(image):
        nonlocal engine
        if engine is None:
            from paddleocr import PaddleOCR

            # enable_mkldnn=False: paddlepaddle 3.3 CPU의 oneDNN 오류를 피합니다.
            engine = PaddleOCR(lang="korean", use_doc_orientation_classify=False, use_doc_unwarping=False,
                               use_textline_orientation=False, enable_mkldnn=False)
        lines = []
        for result in engine.predict(image):
            for text, box in zip(result["rec_texts"], result["rec_boxes"]):
                lines.append((round(float(box[1]) / 20), float(box[0]), text))  # 같은 줄(20px 안)은 왼쪽부터
        return [text for _, _, text in sorted(lines)]

    return ocr
