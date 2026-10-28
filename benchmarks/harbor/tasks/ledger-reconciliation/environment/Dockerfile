FROM python:3.12.12-slim-bookworm
RUN groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home agent \
    && mkdir -p /app/output /logs/agent /logs/verifier
COPY app/ /app/
RUN chown -R agent:agent /app /logs/agent
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
