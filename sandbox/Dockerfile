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
    && cp /etc/apt/sources.list.d/debian.sources /tmp/debian.sources.official \
    && python -c 'from pathlib import Path; p=Path("/etc/apt/sources.list.d/debian.sources"); s=p.read_text(); s=s.replace("http://deb.debian.org/debian-security", "https://mirrors.aliyun.com/debian-security").replace("https://deb.debian.org/debian-security", "https://mirrors.aliyun.com/debian-security").replace("http://deb.debian.org/debian", "https://mirrors.aliyun.com/debian").replace("https://deb.debian.org/debian", "https://mirrors.aliyun.com/debian"); p.write_text(s)' \
    && ( (apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o APT::Update::Error-Mode=any update \
          && apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends bash curl ca-certificates iptables iproute2 util-linux openjdk-17-jdk-headless git build-essential procps findutils) \
         || (echo 'Domestic APT mirror failed; retrying with original official sources.' >&2 \
             && cp /tmp/debian.sources.official /etc/apt/sources.list.d/debian.sources \
             && rm -rf /var/lib/apt/lists/* \
             && apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o APT::Update::Error-Mode=any update \
             && apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends bash curl ca-certificates iptables iproute2 util-linux openjdk-17-jdk-headless git build-essential procps findutils) ) \
    && cp /tmp/debian.sources.official /etc/apt/sources.list.d/debian.sources \
    && rm /tmp/debian.sources.official \
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
