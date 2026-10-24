# services/router image (ECR repository ms-router). Not pushed unless AWS_DEPLOY=1; see docs/ROUTER.md.
FROM public.ecr.aws/docker/library/python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir fastapi==0.162.0 "uvicorn[standard]==0.54.0" pydantic==2.14.1 httpx==0.28.1 \
    boto3==1.43.118 python-dotenv==1.2.4
COPY router ./router
COPY config ./config
ENV PORT=7200
EXPOSE 7200
USER nobody
CMD ["uvicorn", "router.main:app", "--host", "0.0.0.0", "--port", "7200"]
