import json
from contextlib import nullcontext
from types import SimpleNamespace


class FakeClient:
    """Stands in for anthropic.Anthropic: records requests, returns canned text."""

    def __init__(self, reply, stop_reason="end_turn"):
        self.reply = reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False)
        self.stop_reason = stop_reason
        self.requests = []
        self.streamed = []  # stream()으로 보낸 요청(긴 답을 받는 요점 정리)
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create, stream=self._stream))

    def _stream(self, **kwargs):
        self.streamed.append(kwargs)
        response = self._create(**kwargs)
        return nullcontext(SimpleNamespace(get_final_message=lambda: response))

    def _create(self, **kwargs):
        self.requests.append(kwargs)
        return SimpleNamespace(
            stop_reason=self.stop_reason,
            content=[SimpleNamespace(type="thinking", thinking=""),
                     SimpleNamespace(type="text", text=self.reply)],
        )


def quiz_guide(*questions):
    """그 문제들이 있는 요점 정리(퀴즈 결과는 강의에 있는 문제만 기록하므로)."""
    return {"summary": "요약", "chapters": [], "quiz": [
        {"question": q, "choices": ["가", "나"], "answer": 0, "explanation": "", "time": 0.0} for q in questions]}
