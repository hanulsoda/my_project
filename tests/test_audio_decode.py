import wave

from faster_whisper.audio import decode_audio


def test_installed_whisper_can_read_audio(tmp_path):
    # 받아쓰기 첫 단계인 음성 읽기. 설치된 라이브러리 버전끼리 안 맞으면 여기서 깨집니다(예: PyAV 19).
    path = tmp_path / "one_second.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 16000)

    audio = decode_audio(str(path))

    assert abs(len(audio) - 16000) < 160  # 1초 = 16kHz 샘플 16000개
