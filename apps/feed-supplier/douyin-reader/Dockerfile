FROM python:3.12-slim

# F2 needs Python 3.11 or newer.

# Mainland networks can pass a reachable package index, for example a university mirror.
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp

WORKDIR /app
COPY requirements.txt ./
RUN pip install --index-url "$PIP_INDEX_URL" -r requirements.txt
COPY douyin_reader ./douyin_reader

USER nobody
EXPOSE 3011
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3011/health', timeout=4)"]
CMD ["python", "-m", "douyin_reader"]
