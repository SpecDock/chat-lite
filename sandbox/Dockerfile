ARG PYTHON_IMAGE=docker.m.daocloud.io/library/python:3.12-slim
FROM ${PYTHON_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN python -m pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple --trusted-host mirrors.aliyun.com pandas openpyxl \
    || python -m pip install --no-cache-dir pandas openpyxl \
    && useradd --uid 1000 --create-home --shell /usr/sbin/nologin table-sandbox

USER table-sandbox
WORKDIR /tmp
CMD ["python", "-I", "-B", "-c", "raise SystemExit('sandbox worker')"]
