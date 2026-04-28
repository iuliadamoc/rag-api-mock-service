# RAG API Mock Service

This project is a mock implementation of a Retrieval-Augmented Generation (RAG) API based on an OpenAPI specification.

The goal of this project is to demonstrate the ability to interpret and implement a complex API contract, focusing on correctness, structure, and compliance rather than full AI functionality.

---

## 🚀 Features

- Implements core endpoints:
  - `POST /v1/query`
  - `POST /v1/ingest`
  - `GET /v1/ingest/:job_id`
  - `GET /v1/health`
  - `GET /v1/namespaces/:id/stats` (bonus)
- Request validation using **Zod**
- Header validation (Authorization, Tenant, Request ID)
- Idempotent ingest endpoint
- Multi-namespace query simulation
- Proper error handling based on spec
- "No result" handling (no hallucinations)

---

## 🧠 Design Decisions

This is a **mock implementation**, meaning:

- No real embeddings or vector database
- No real LLM integration
- Focus is on:
  - API contract compliance
  - Response structure correctness
  - Edge case handling

---

## 🛠️ Tech Stack

- Node.js
- Express.js
- Zod (validation)
- UUID

---

## ▶️ How to Run

```bash
npm install
node index.js