# Backend container (docs/PLAN.md §10.3, §10.6). The interpreter is pinned exactly like the
# repo: python:3.15.2-slim + uv sync --frozen — nothing installs by feel.
#
# Build context is the repo root:
#   docker build -f deploy/Dockerfile -t hongkong-stories-api .
FROM python:3.15.2-slim

RUN pip install --no-cache-dir uv

WORKDIR /app/server
COPY server/pyproject.toml server/uv.lock ./
RUN uv sync --frozen --no-dev

COPY server/ ./

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uv", "run", "--frozen", "--no-dev", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]