# RAG API Mock Service

This project is a mock implementation of a Retrieval-Augmented Generation (RAG) API based on a given external specification.

The goal was to build a backend that respects the contract and behaves like a real service, even if the AI part is simulated.

## Features

- Implemented endpoints:
  - POST /v1/query
  - POST /v1/ingest
  - GET /v1/ingest/:job_id
  - GET /v1/namespaces/:id/stats
  - POST /v1/eval
  - GET /v1/health
  - GET /metrics
  - GET /v1/openapi.json

- Request validation using Zod
- Header validation (Authorization, X-Request-ID, X-Tenant-ID)
- Basic API key authentication
- Tenant validation (403 for invalid tenant)
- Idempotent ingest endpoint (Idempotency-Key support)
- Multipart file upload support
- Stable UUID generation for chunks
- Multi-namespace query simulation
- Article hint support (hint_article_number)
- Proper error handling (including 502, 503, 504)
- "No result" handling (no hallucinations)

## Observability

The service exposes Prometheus-style metrics at /metrics.

Metrics include:
- http_requests_total (with method, endpoint, status)
- request duration
- token usage (simulated)
- cost (simulated)
- external error counters

Each request also includes:
- X-Request-ID
- X-Vendor-Trace-ID
- Server-Timing header

## Design Notes

This is a mock service:
- No real embeddings or vector database
- No real LLM integration
- Retrieval and ranking are simulated

The focus was on:
- following the API spec as closely as possible
- handling edge cases correctly
- keeping the structure similar to a real production service

## Tech Stack

- Node.js
- Express
- Zod
- Multer (file upload)
- crypto (for stable IDs)

## How to run

```bash
npm install
node index.js