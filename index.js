const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { z } = require("zod");

const app = express();
app.use(express.json());
const fs = require("fs");

// In-memory storage
const jobsByKey = new Map();
const rateLimitStore = new Map();
const existingNamespaces = new Set(["legea_31_1990"]);
const namespaceData = new Map();

const metrics = {
  http_requests_total: {},
  http_request_duration: [],
  vendor_cost_usd_total: 0,
  vendor_tokens_input: 0,
  vendor_tokens_output: 0,
  vendor_external_api_errors_total: 0
};

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
  const tenant = req.headers["x-tenant-id"] || "default";

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

app.use((req, res, next) => {
  const key = `${req.method}_${req.path}`;

  metrics.http_requests_total[key] =
    (metrics.http_requests_total[key] || 0) + 1;

  next();
});

app.use((req, res, next) => {
  if (req.path === "/v1/health") return next();

  const tenant = req.headers["x-tenant-id"] || "default";
  const now = Date.now();

  const WINDOW_MS = 60 * 1000; // 1 minute
  const LIMIT = 10;

  let record = rateLimitStore.get(tenant);

  if (!record) {
    record = {
      count: 0,
      resetTime: now + WINDOW_MS
    };
  }

  // reset window
  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + WINDOW_MS;
  }

  record.count += 1;

  const remaining = Math.max(LIMIT - record.count, 0);
  const resetSeconds = Math.ceil((record.resetTime - now) / 1000);

  // SET HEADERS (IMPORTANT)
  res.set("RateLimit-Limit", LIMIT.toString());
  res.set("RateLimit-Remaining", remaining.toString());
  res.set("RateLimit-Reset", resetSeconds.toString());

  rateLimitStore.set(tenant, record);

  // BLOCK if over limit
  if (record.count > LIMIT) {
    res.set("Retry-After", resetSeconds.toString());

    return res.status(429).json({
      error: {
        code: "rate_limited",
        message: "Too many requests",
        request_id: req.requestId
      }
    });
  }

  next();
});

// QUERY
app.post("/v1/query", (req, res) => {
  const start = Date.now();

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

  const {
    question,
    namespaces,
    include_answer = true,
    hint_article_number: hint,
    rerank,
    style_hints = {},
    conversation_history = [],
    top_k
  } = req.body;

  const maxChars = style_hints.answer_max_chars || 2000;
  const topK = Math.min(Math.max(top_k || 5, 1), 50);

  // LIMIT conversation history (spec)
  if (conversation_history.length > 15) {
    return res.status(422).json({
      error: {
        code: "validation_error",
        message: "Too many conversation turns",
        request_id: req.requestId
      }
    });
  }

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

  const lowerQuestion = question.toLowerCase();

  // OUT-OF-DOMAIN → EMPTY RESULT (spec)
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
      model_version: "mock-1.0:2026-04",
      confidence: 0.0
    });
  }

  // GET DATA
  const data = validNamespaces.flatMap(ns => namespaceData.get(ns) || []);

  if (data.length === 0) {
    return res.json({
      request_id: req.requestId,
      answer: null,
      citations: [],
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cost_usd: 0,
        model_id: "mock-model"
      },
      latency_ms: 120,
      model_version: "mock-1.0:2026-04",
      confidence: 0.0
    });
  }

  // SCORING (mini RAG)
  const scored = data.map(item => {
    let score = 0;
    const content = (item.content || "").toLowerCase();

    // exact match
    if (content.includes(lowerQuestion)) score += 0.5;

    // keyword match
    lowerQuestion.split(" ").forEach(w => {
      if (w.length > 2 && content.includes(w)) score += 0.1;
    });

    // article hint boost
    if (hint && item.article_number === hint) {
      score += 0.5;
    }

    // conversation context boost
    conversation_history.forEach(turn => {
      if (turn.role === "user") {
        const prev = turn.content.toLowerCase();
        if (content.includes(prev)) score += 0.2;
      }
    });

    return {
      ...item,
      score: Math.min(score, 1)
    };
  });

  // SORT + LIMIT
  let finalData = scored.sort((a, b) => b.score - a.score);

  if (rerank) {
    finalData = finalData.sort(() => Math.random() - 0.5);
  }

  finalData = finalData.slice(0, topK);

  if (finalData.length === 0) {
    return res.json({
      request_id: req.requestId,
      answer: null,
      citations: [],
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cost_usd: 0,
        model_id: "mock-model"
      },
      latency_ms: 120,
      model_version: "mock-1.0:2026-04",
      confidence: 0.0
    });
  }

  // CITATIONS
  const citations = finalData.slice(0, 3).map((item, i) => ({
    marker: `[${i + 1}]`,
    chunk: {
      chunk_id: item.chunk_id || uuidv4(),
      content: item.content,
      article_number: item.article_number,

      section_title: item.section_title || null,
      point_number: item.point_number || null,
      page_number: item.page_number || null,

      source_id: item.source_id,
      source_url: item.source_url || null,
      source_title: item.source_title || null,

      namespace_id: item.namespace_id,
      score: item.score,

      metadata: item.metadata || {}
    }
  }));

  // ANSWER (multi-chunk)
  let answerText = finalData
    .slice(0, 2)
    .map((d, i) => `${d.content} [${i + 1}]`)
    .join(" ");

  answerText = answerText ? answerText.slice(0, maxChars) : null;

  const latency = Date.now() - start;
  const confidence = finalData.length > 0 ? 0.9 : 0.0;

  // HEADERS (observability)
  res.set("Server-Timing", `total;dur=${latency}`);
  res.set("X-Vendor-Retrieval-Strategy", "hybrid_scoring_v2");

  // RESPONSE (respect include_answer)
  const response = {
    request_id: req.requestId,
    citations,
    usage: {
      input_tokens: 100,
      output_tokens: include_answer ? 50 : 0,
      cost_usd: 0.001,
      model_id: "mock-model"
    },
    latency_ms: latency,
    model_version: "mock-1.0:2026-04",
    confidence,
    retrieval_strategy: "hybrid_scoring_v2",
    trace_id: "trace_" + uuidv4()
  };

  if (include_answer) {
    response.answer = answerText;
  }

  const duration = (Date.now() - start) / 1000;

  metrics.http_request_duration.push(duration);
  metrics.vendor_tokens_input += 100;
  metrics.vendor_tokens_output += 50;
  metrics.vendor_cost_usd_total += 0.001;

  return res.json(response);
});

app.post("/v1/eval", (req, res) => {
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

  const { question, namespaces } = req.body;

  const expectedCitations = req.body.expected_citations || [];
  const expectedKeywords = req.body.expected_answer_keywords || [];

  // namespace validation
  const validNamespaces = namespaces.filter(ns => existingNamespaces.has(ns));

  if (validNamespaces.length === 0) {
    return res.status(404).json({
      error: {
        code: "namespace_not_found",
        message: "No indexed content",
        request_id: req.requestId
      }
    });
  }

  const data = validNamespaces.flatMap(ns => namespaceData.get(ns) || []);

  // no data case
  if (data.length === 0) {
    return res.json({
      request_id: req.requestId,
      answer: null,
      citations: [],
      eval: {
        citation_precision_at_k: 0,
        keyword_match_rate: 0
      }
    });
  }

  // generate mock answer
  const answer = `${data[0].content} [1]`;

  const citations = data.slice(0, 3).map((item, i) => ({
    marker: `[${i + 1}]`,
    chunk: {
      chunk_id: item.chunk_id || uuidv4(),
      content: item.content,
      article_number: item.article_number,
      source_id: item.source_id,
      namespace_id: item.namespace_id,
      score: 0.9 - i * 0.1
    }
  }));

  // EVAL METRICS

  // 1. citation precision
  let correctCitations = 0;
  citations.forEach(c => {
    if (expectedCitations.includes(c.chunk.chunk_id)) {
      correctCitations++;
    }
  });

  const precision = citations.length > 0
    ? correctCitations / citations.length
    : 0;

  // 2. keyword match
  let keywordMatches = 0;
  expectedKeywords.forEach(k => {
    if (answer.toLowerCase().includes(k.toLowerCase())) {
      keywordMatches++;
    }
  });

  const keywordRate = expectedKeywords.length > 0
    ? keywordMatches / expectedKeywords.length
    : 1;

  return res.json({
    request_id: req.requestId,
    answer,
    citations,
    eval: {
      citation_precision_at_k: Number(precision.toFixed(2)),
      keyword_match_rate: Number(keywordRate.toFixed(2))
    }
  });
});

// INGEST
app.post("/v1/ingest", (req, res) => {
  const key = req.headers["idempotency-key"];
  const body = req.body;

  if (!key) {
    return res.status(400).json({
      error: {
        code: "invalid_request",
        message: "Missing Idempotency-Key",
        request_id: req.requestId
      }
    });
  }

  existingNamespaces.add(body.namespace_id);

  // CHECK EXISTING
  if (jobsByKey.has(key)) {
    const existing = jobsByKey.get(key);

    // SAME BODY → return same job
    if (JSON.stringify(existing.body) === JSON.stringify(body)) {
      return res.status(202).json(existing.job);
    }

    // DIFFERENT BODY → 409
    return res.status(409).json({
      error: {
        code: "duplicate_job",
        message: "Idempotency-Key already used with different payload",
        request_id: req.requestId
      }
    });
  }

  // CREATE NEW JOB
  const job = {
    job_id: "j_" + uuidv4(),
    status: "queued",

    namespace_id: body.namespace_id,
    source_id: body.source_id,

    submitted_at: new Date().toISOString(),
    estimated_completion_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
  };

  // SAVE job + body
  jobsByKey.set(key, {
    job,
    body
  });

  // OPTIONAL: save fake data for query
  if (!namespaceData.has(body.namespace_id)) {
    namespaceData.set(body.namespace_id, []);
  }

  namespaceData.get(body.namespace_id).push({
    content: "Articolul 15. — Aporturile în numerar sunt obligatorii.",
    article_number: "15",
    source_id: body.source_id,
    namespace_id: body.namespace_id,
    section_title: "Capitolul II",
    point_number: "a",
    page_number: 7,
    metadata: {
      document_type: "lege"
    },
    source_url: body.url || null,
    source_title: body.metadata?.source_title || null
  });

  return res.status(202).json(job);
});

// INGEST STATUS
app.get("/v1/ingest/:job_id", (req, res) => {
  const jobId = req.params.job_id;

  // find job by id (search in jobsByKey)
  const jobEntry = [...jobsByKey.values()].find(j => j.job.job_id === jobId);

  if (!jobEntry) {
    return res.status(404).json({
      error: {
        code: "not_found",
        message: "Job not found",
        request_id: req.requestId
      }
    });
  }

  const job = jobEntry.job;

  // simulate progress stages
  const stageMap = {
    queued: { stage: "queued", percent: 10 },
    fetching: { stage: "fetching", percent: 30 },
    chunking: { stage: "chunking", percent: 50 },
    embedding: { stage: "embedding", percent: 70 },
    indexing: { stage: "indexing", percent: 90 },
    done: { stage: "done", percent: 100 }
  };

  const progress = stageMap[job.status] || { stage: "queued", percent: 0 };

  // add retry-after if not done
  if (job.status !== "done") {
    res.set("Retry-After", "5");
  }

  return res.json({
    job_id: job.job_id,
    namespace_id: job.namespace_id,
    source_id: job.source_id,
    status: job.status,
    progress: {
      stage: progress.stage,
      percent: progress.percent,
      chunks_created: progress.percent > 50 ? 10 : 0
    },
    submitted_at: job.submitted_at,
    completed_at: job.completed_at || null,
    error: null
  });
});

// DELETE source
app.delete("/v1/namespaces/:namespace_id/sources/:source_id", (req, res) => {
  const { namespace_id, source_id } = req.params;

  // Check if namespace exists
  if (!namespaceData.has(namespace_id)) {
    return res.status(404).json({
      error: {
        code: "not_found",
        message: "Namespace not found",
        request_id: req.requestId
      }
    });
  }

  const data = namespaceData.get(namespace_id);

  // Remove all chunks belonging to the given source
  const filtered = data.filter(item => item.source_id !== source_id);

  // If nothing changed, source does not exist
  if (filtered.length === data.length) {
    return res.status(404).json({
      error: {
        code: "not_found",
        message: "Source not found",
        request_id: req.requestId
      }
    });
  }

  // Persist updated data
  namespaceData.set(namespace_id, filtered);

  // No content response as per spec
  return res.status(204).send();
});

// DELETE namespace
app.delete("/v1/namespaces/:namespace_id", (req, res) => {
  const { namespace_id } = req.params;

  // Check if namespace exists
  if (!namespaceData.has(namespace_id)) {
    return res.status(404).json({
      error: {
        code: "not_found",
        message: "Namespace not found",
        request_id: req.requestId
      }
    });
  }

  // Remove entire namespace and all associated data
  namespaceData.delete(namespace_id);
  existingNamespaces.delete(namespace_id);

  // Return async deletion response (as required by spec)
  return res.status(202).json({
    job_id: "del_" + uuidv4(),
    status: "queued",
    sla: "24h"
  });
});

app.get("/v1/namespaces/:namespace_id/stats", (req, res) => {
  const namespaceId = req.params.namespace_id;

  // validate namespace
  if (!namespaceData.has(namespaceId)) {
    return res.status(404).json({
      error: {
        code: "namespace_not_found",
        message: `Namespace '${namespaceId}' not found`,
        request_id: req.requestId,
        details: { namespace_id: namespaceId }
      }
    });
  }

  const data = namespaceData.get(namespaceId) || [];

  // compute metrics
  const chunkCount = data.length;

  const sourceSet = new Set();
  let totalTokens = 0;

  data.forEach(d => {
    if (d.source_id) sourceSet.add(d.source_id);

    // simulate token count based on content length
    if (d.content) {
      totalTokens += Math.ceil(d.content.length / 4);
    }
  });

  const sourceCount = sourceSet.size;

  // realistic last ingest
  const lastIngestedAt = chunkCount > 0
    ? new Date().toISOString()
    : null;

  // simulate embedding model variation
  const embeddingModel = "text-embedding-3-small";
  const embeddingDim = 1536;

  return res.json({
    namespace_id: namespaceId,
    chunk_count: chunkCount,
    source_count: sourceCount,
    total_tokens_indexed: totalTokens,
    last_ingested_at: lastIngestedAt,
    embedding_model: embeddingModel,
    embedding_dim: embeddingDim
  });
});

app.get("/v1/openapi.json", (req, res) => {
  const spec = fs.readFileSync("./openapi.json", "utf-8");
  res.set("Content-Type", "application/json");
  res.send(spec);
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
  metrics.vendor_external_api_errors_total += 1;
  res.status(500).json({
    error: {
      code: "internal_error",
      message: "Something went wrong",
      request_id: req.requestId || null
    }
  });
});

app.get("/metrics", (req, res) => {
  let output = "";

  for (const key in metrics.http_requests_total) {
    output += `http_requests_total{endpoint="${key}"} ${metrics.http_requests_total[key]}\n`;
  }

  metrics.http_request_duration.forEach(d => {
    output += `http_request_duration_seconds ${d}\n`;
  });

  output += `vendor_tokens_total{direction="input"} ${metrics.vendor_tokens_input}\n`;
  output += `vendor_tokens_total{direction="output"} ${metrics.vendor_tokens_output}\n`;

  output += `vendor_cost_usd_total ${metrics.vendor_cost_usd_total}\n`;

  output += `vendor_external_api_errors_total ${metrics.vendor_external_api_errors_total}\n`;

  res.set("Content-Type", "text/plain");
  res.send(output);
});

app.listen(8080, () => {
  console.log("Server running on http://localhost:8080");
});