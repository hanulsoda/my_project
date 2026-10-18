# 학생용 웹 서버만 담은 이미지 (분석용 Whisper는 넣지 않음)
FROM python:3.12-slim
WORKDIR /app
COPY requirements-server.txt .
RUN pip install --no-cache-dir -r requirements-server.txt
COPY academy/ academy/
ENV VIDEO_DIR=/videos DATA_DIR=/data
EXPOSE 8000
# --proxy-headers: 시놀로지 역방향 프록시가 알려 주는 https 여부를 받아 쿠키에 Secure를 붙입니다.
CMD ["uvicorn", "academy.server:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
