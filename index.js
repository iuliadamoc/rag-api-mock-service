const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { z } = require("zod");

const app = express();
app.use(express.json());

// --- In-memory storage (pentru idempotency)
const jobsByKey = new Map();

// --- Logging middleware (bonus)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// --- Schema validare ---
const QuerySchema = z.object({
  question: z.string().min(1).max(2000),
  language: z.literal("ro"),
  namespaces: z.array(z.string()).min(1).max(10),
  top_k: z.number().int().min(1).max(50).optional(),
  include_answer: z.boolean().optional()
});

// --- Middleware headers ---
app.use((req, res, next) => {
  if (req.path === "/v1/health") return next();

  const auth = req.headers["authorization"];
  const requestId = req.headers["x-request-id"];
  const tenant = req.headers["x-tenant-id"];

  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({
      error: { code: "unauthorized", message: "Missing/invalid Authorization", request_id: requestId || null }
    });
  }

  if (!requestId) {
    return res.status(400).json({
      error: { code: "invalid_request", message: "Missing X-Request-ID", request_id: null }
    });
  }

  if (!tenant) {
    return res.status(400).json({
      error: { code: "invalid_request", message: "Missing X-Tenant-ID", request_id: requestId }
    });
  }

  req.requestId = requestId;

  // headers PRO
  res.set("X-Request-ID", requestId);
  res.set("X-Vendor-Trace-ID", "trace_" + uuidv4());
  res.set("Server-Timing", "retrieval;dur=50, generation;dur=120");

  next();
});

// --- 1) QUERY ---
app.post("/v1/query", (req, res) => {
  const parsed = QuerySchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(422).json({
      error: {
        code: "validation_error",
        message: "Invalid body",
        request_id: req.requestId,
        details: parsed.error.flatten()
      }
    });
  }

  const { question, namespaces, include_answer = true } = req.body;

  // NO RESULT CASE (important)
  if (question.toLowerCase().includes("programul primariei")) {
    return res.json({
      request_id: req.requestId,
      answer: null,
      citations: [],
      usage: { input_tokens: 10, output_tokens: 0, cost_usd: 0, model_id: "mock" },
      latency_ms: 100,
      model_version: "mock-1.0",
      confidence: 0.0
    });
  }

  // MULTI-NAMESPACE (bonus)
  const citations = namespaces.map((ns, i) => ({
    marker: `[${i + 1}]`,
    chunk: {
      chunk_id: uuidv4(),
      content: `Conținut relevant din ${ns}...`,
      article_number: "15",
      source_id: "s_" + (i + 1),
      namespace_id: ns,
      score: 0.9 - i * 0.1
    }
  }));

  return res.json({
    request_id: req.requestId,
    answer: include_answer
      ? "Articolul 15 din Legea 31/1990 prevede că aporturile în numerar sunt obligatorii [1]."
      : null,
    citations,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.001,
      model_id: "mock-model"
    },
    latency_ms: 400,
    model_version: "mock-1.0",
    confidence: 0.9
  });
});

// --- 2) INGEST ---
app.post("/v1/ingest", (req, res) => {
  const key = req.headers["idempotency-key"];

  if (!key) {
    return res.status(400).json({
      error: { code: "invalid_request", message: "Missing Idempotency-Key", request_id: req.requestId }
    });
  }

  // dacă există deja → returnezi același job
  if (jobsByKey.has(key)) {
    return res.status(202).json(jobsByKey.get(key));
  }

  const job = {
    job_id: "j_" + uuidv4(),
    status: "queued",
    submitted_at: new Date().toISOString(),
    estimated_completion_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
  };

  jobsByKey.set(key, job);

  return res.status(202).json(job);
});

// --- 3) INGEST STATUS ---
app.get("/v1/ingest/:job_id", (req, res) => {
  return res.json({
    job_id: req.params.job_id,
    namespace_id: "legea_31_1990",
    source_id: "s_1",
    status: "done",
    progress: {
      stage: "indexing",
      percent: 100,
      chunks_created: 10
    },
    submitted_at: new Date(Date.now() - 60000).toISOString(),
    completed_at: new Date().toISOString(),
    error: null
  });
});

// --- 4) DELETE namespace (bonus)
app.delete("/v1/namespaces/:namespace_id", (req, res) => {
  return res.status(202).json({
    job_id: "del_" + uuidv4(),
    status: "queued",
    sla: "24h"
  });
});

// --- 5) HEALTH ---
app.get("/v1/health", (req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0",
    uptime_seconds: Math.floor(process.uptime()),
    dependencies: {
      vector_store: "ok",
      llm: "ok",
      object_store: "ok"
    }
  });
});

// --- Global error handler (pro)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    error: {
      code: "internal_error",
      message: "Something went wrong",
      request_id: req.requestId || null
    }
  });
});

app.listen(8080, () => {
  console.log("Server running on http://localhost:8080");
});