ARG PYTHON_IMAGE=docker.m.daocloud.io/library/python:3.12-slim-bookworm
ARG GO_IMAGE=docker.m.daocloud.io/library/golang:1.26-bookworm
FROM ${GO_IMAGE} AS go-toolchain
FROM ${PYTHON_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    OPENBLAS_NUM_THREADS=1 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1

RUN (python -m pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple --trusted-host mirrors.aliyun.com pandas openpyxl \
     || python -m pip install --no-cache-dir pandas openpyxl) \
    && apt-get update \
    && apt-get install -y --no-install-recommends bash curl ca-certificates iptables iproute2 util-linux openjdk-17-jdk-headless git build-essential procps findutils \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --no-create-home --shell /usr/sbin/nologin table-sandbox

COPY entrypoint.sh /usr/local/bin/chatlite-sandbox-init
COPY --from=go-toolchain /usr/local/go /usr/local/go
RUN chmod 755 /usr/local/bin/chatlite-sandbox-init

# /tmp, /run and every writable HOME/cache are quota-bound by the broker.
# /dev/shm is explicitly 1MiB and charged to the same 512MiB memory cgroup.
ENV PATH=/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER table-sandbox
WORKDIR /work
CMD ["python", "-I", "-B", "-c", "raise SystemExit('sandbox worker')"]
