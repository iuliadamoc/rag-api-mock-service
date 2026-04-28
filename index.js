const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { z } = require("zod");

const app = express();
app.use(express.json());

// In-memory storage
const jobsByKey = new Map();

const existingNamespaces = new Set(["legea_31_1990"]);
const namespaceData = new Map();

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Validation schema
const QuerySchema = z.object({
  question: z.string().min(1).max(2000),
  language: z.literal("ro"),
  namespaces: z.array(z.string()).min(1).max(10),
  top_k: z.number().int().min(1).max(50).optional(),
  include_answer: z.boolean().optional()
});

// Middleware headers
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

  // headers
  res.set("X-Request-ID", requestId);
  res.set("X-Vendor-Trace-ID", "trace_" + uuidv4());
  res.set("Server-Timing", "retrieval;dur=50, generation;dur=120");

  next();
});

// QUERY
app.post("/v1/query", (req, res) => {
  // BODY VALIDATION
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

  // NAMESPACE CHECK
  const validNamespaces = namespaces.filter(ns => existingNamespaces.has(ns));

  if (validNamespaces.length === 0) {
    return res.status(404).json({
      error: {
        code: "namespace_not_found",
        message: "No indexed content for provided namespace",
        request_id: req.requestId
      }
    });
  }

  //NO RESULT CASE
  const lowerQuestion = question.toLowerCase();

  if (
    lowerQuestion.includes("programul primariei") ||
    lowerQuestion.includes("orar") ||
    lowerQuestion.includes("program")
  ) {
    return res.json({
      request_id: req.requestId,
      answer: null,
      citations: [],
      usage: {
        input_tokens: 20,
        output_tokens: 0,
        cost_usd: 0,
        model_id: "mock-model"
      },
      latency_ms: 120,
      model_version: "mock-1.0",
      confidence: 0.0
    });
  }

  // CITATIONS 
  const citations = validNamespaces.map((ns, i) => ({
    marker: `[${i + 1}]`,
    chunk: {
      chunk_id: uuidv4(),
      content: `Conținut relevant extras din ${ns}, articolul 15...`,
      article_number: "15",
      source_id: "s_" + (i + 1),
      source_url: "https://legislatie.just.ro/",
      source_title: "Document legislativ",
      namespace_id: ns,
      score: 0.9 - i * 0.1
    }
  }));

  const hasArticleHint = lowerQuestion.includes("15");

  const answerText = hasArticleHint
    ? "Articolul 15 din Legea 31/1990 prevede că aporturile în numerar sunt obligatorii [1]."
    : "Conform legislației relevante, informațiile solicitate sunt detaliate în cadrul documentelor disponibile [1].";

  // METRICS REALISTE
  const latency = Math.floor(Math.random() * 300) + 200;
  const confidence = validNamespaces.length > 1 ? 0.85 : 0.92;

  return res.json({
    request_id: req.requestId,
    answer: include_answer ? answerText : null,
    citations,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.001,
      model_id: "mock-model"
    },
    latency_ms: latency,
    model_version: "mock-1.0",
    confidence
  });
});

// INGEST
app.post("/v1/ingest", (req, res) => {
  const key = req.headers["idempotency-key"];

  // validate idempotency key
  if (!key) {
    return res.status(400).json({
      error: {
        code: "invalid_request",
        message: "Missing Idempotency-Key",
        request_id: req.requestId
      }
    });
  }

  // return existing job if same key
  if (jobsByKey.has(key)) {
    return res.status(202).json(jobsByKey.get(key));
  }

  const { namespace_id, source_id } = req.body;

  // validate minimal required fields
  if (!namespace_id || !source_id) {
    return res.status(422).json({
      error: {
        code: "validation_error",
        message: "Missing required fields",
        request_id: req.requestId
      }
    });
  }

  // ensure namespace exists in mock storage
  existingNamespaces.add(namespace_id);

  // init namespace data if not exists
  if (!namespaceData.has(namespace_id)) {
    namespaceData.set(namespace_id, []);
  }

  // create ingestion job
  const jobId = "j_" + uuidv4();

  const job = {
    job_id: jobId,
    namespace_id,
    source_id,
    status: "queued",
    submitted_at: new Date().toISOString(),
    estimated_completion_at: new Date(Date.now() + 5000).toISOString()
  };

  jobsByKey.set(key, job);

  // simulate async ingestion pipeline
  setTimeout(() => {
    job.status = "fetching";
  }, 1000);

  setTimeout(() => {
    job.status = "chunking";
  }, 2000);

  setTimeout(() => {
    job.status = "embedding";
  }, 3000);

  setTimeout(() => {
    job.status = "indexing";

    // simulate adding indexed content
    namespaceData.get(namespace_id).push({
      content: "Articolul 15. — Aporturile în numerar sunt obligatorii.",
      article_number: "15",
      source_id
    });
  }, 4000);

  setTimeout(() => {
    job.status = "done";
    job.completed_at = new Date().toISOString();
  }, 5000);

  return res.status(202).json(job);
});

// INGEST STATUS
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

// DELETE namespace
app.delete("/v1/namespaces/:namespace_id", (req, res) => {
  return res.status(202).json({
    job_id: "del_" + uuidv4(),
    status: "queued",
    sla: "24h"
  });
});

app.delete("/v1/namespaces/:namespace_id/sources/:source_id", (req, res) => {
  return res.status(204).send();
});

app.get("/v1/namespaces/:namespace_id/stats", (req, res) => {
  res.json({
    namespace_id: req.params.namespace_id,
    chunk_count: 120,
    source_count: 3,
    total_tokens_indexed: 15000,
    last_ingested_at: new Date().toISOString(),
    embedding_model: "mock-embedding",
    embedding_dim: 1536
  });
});

app.get("/v1/openapi.json", (req, res) => {
  res.json({
    openapi: "3.0.0",
    info: {
      title: "RAG API Mock",
      version: "1.0.0"
    },
    paths: {
      "/v1/query": { post: {} },
      "/v1/ingest": { post: {} }
    }
  });
});

// HEALTH
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

// Global error handler
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