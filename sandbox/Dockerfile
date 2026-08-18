FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN python -m pip install --no-cache-dir pandas openpyxl \
    && useradd --uid 1000 --create-home --shell /usr/sbin/nologin table-sandbox \
    && mkdir -p /run/table-sandbox/jobs \
    && chown -R table-sandbox:table-sandbox /run/table-sandbox

COPY sandbox/runner.py /opt/table-sandbox/runner.py
RUN chown -R table-sandbox:table-sandbox /opt/table-sandbox

USER table-sandbox
WORKDIR /run/table-sandbox
CMD ["python", "/opt/table-sandbox/runner.py"]
