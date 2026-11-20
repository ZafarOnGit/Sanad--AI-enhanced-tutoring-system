import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, type Auth } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.resolve(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
).href;

interface EncryptedBlob {
  iv: string;
  tag: string;
  ciphertext: string;
}

function getFirebaseApiKey(): string {
  if (process.env.VITE_FIREBASE_API_KEY) {
    return process.env.VITE_FIREBASE_API_KEY.trim();
  }
  try {
    const cfgPath = path.resolve(__dirname, 'firebase-applet-config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw) as { apiKey?: string };
    return typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
  } catch {
    return '';
  }
}

function getEncryptionKeyBuffer(): Buffer | null {
  const rawKey = process.env.ENCRYPTION_KEY?.trim();
  if (!rawKey) return null;
  try {
    const buf = Buffer.from(rawKey, 'base64');
    if (buf.length !== 32) {
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

function encryptAes256Gcm(plaintext: string, key: Buffer): EncryptedBlob {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

function decryptAes256Gcm(blob: EncryptedBlob, key: Buffer): string {
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('Invalid AES-256-GCM envelope');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

async function verifyFirebaseBearerToken(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken) return null;

  const apiKey = getFirebaseApiKey();
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { users?: Array<{ localId?: string }> };
    return data?.users?.[0]?.localId ?? null;
  } catch {
    return null;
  }
}

interface FirebaseAppletConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  firestoreDatabaseId?: string;
}

let serverFirebaseApp: FirebaseApp | null = null;
let serverFirebaseAuth: Auth | null = null;
let serverFirestoreDb: Firestore | null = null;
let serverSignInPromise: Promise<void> | null = null;

function loadFirebaseAppletConfig(): FirebaseAppletConfig | null {
  try {
    const cfgPath = path.resolve(__dirname, 'firebase-applet-config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    return JSON.parse(raw) as FirebaseAppletConfig;
  } catch (err) {
    console.error('[ServerFirebase] Failed to read firebase-applet-config.json:', err);
    return null;
  }
}

async function getServerFirestore(forceReauth = false): Promise<Firestore> {
  if (!serverFirebaseApp || !serverFirebaseAuth || !serverFirestoreDb) {
    const cfg = loadFirebaseAppletConfig();
    if (!cfg) {
      throw new Error('Firebase configuration is missing on server.');
    }
    const existingApp = getApps().find((a) => a.name === 'sanad-server-rag');
    serverFirebaseApp = existingApp || initializeApp(cfg, 'sanad-server-rag');
    serverFirebaseAuth = getAuth(serverFirebaseApp);
    serverFirestoreDb = cfg.firestoreDatabaseId
      ? getFirestore(serverFirebaseApp, cfg.firestoreDatabaseId)
      : getFirestore(serverFirebaseApp);
  }

  if (forceReauth || !serverFirebaseAuth.currentUser) {
    if (!serverSignInPromise || forceReauth) {
      const serverEmail = process.env.SANAD_SERVER_EMAIL?.trim() || 'admin@sanad.demo';
      const serverPassword = process.env.SANAD_SERVER_PASSWORD?.trim() || 'Admin@2026';
      serverSignInPromise = signInWithEmailAndPassword(
        serverFirebaseAuth,
        serverEmail,
        serverPassword
      )
        .then(() => undefined)
        .finally(() => {
          serverSignInPromise = null;
        });
    }
    await serverSignInPromise;
  }

  return serverFirestoreDb;
}

const SYSTEM_INSTRUCTION =
  'You are an HCT Academic Success Center tutor for first-year students. Use ONLY the course materials provided. Match the student input language strictly: if the student writes in English, write ALL student-facing text (including diagnosis, questions, multiple-choice options, model answers, explanations, and subtopics) strictly in simple English (CEFR B1) with NO Arabic text; if the student writes in Arabic, write ALL student-facing text in Modern Standard Arabic. Never give exam answers or do graded work. Never mention technical terms like chunks, embeddings, or vectors. When citing course materials, cite sources ONLY by file name and slide or page number (for example, "Source: Week 1 What is AI.pdf" or "Source: Week 1 What is AI.pdf, Page 3"). If the problem is not about any topic in the materials, set onTopic to false.';

type StudentLanguage = 'arabic' | 'english';

function detectStudentLanguage(text: string): StudentLanguage {
  const arabicCount = (text.match(/[\u0600-\u06FF]/g) || []).length;
  if (arabicCount === 0) return 'english';
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  if (arabicCount >= 4 || arabicCount >= latinCount) {
    return 'arabic';
  }
  return 'english';
}

function buildLanguageSystemInstruction(lang: StudentLanguage): string {
  const rule =
    lang === 'arabic'
      ? 'STRICT LANGUAGE REQUIREMENT: The student wrote in Arabic. You MUST write EVERY student-facing text field (topic, diagnosis, every question, ALL options, modelAnswer, explanation, subtopic, workedExample, feedback) in Modern Standard Arabic.'
      : 'STRICT LANGUAGE REQUIREMENT: The student wrote in English. You MUST write EVERY student-facing text field (topic, diagnosis, every question, ALL options, modelAnswer, explanation, subtopic, workedExample, feedback) strictly in simple English (CEFR B1). NEVER output Arabic script or Arabic options.';
  return `${SYSTEM_INSTRUCTION} ${rule}`;
}

interface CourseNoteInput {
  course: string;
  topic: string;
  text: string;
  fileName?: string;
  chunkIndex?: number;
}

function makeServerId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

interface DiagnoseRequestBody {
  course?: string;
  studentText?: string;
  attachmentContext?: string;
}

type QuestionType = 'single' | 'multiple' | 'written';

interface RawQuizQuestion {
  type?: string;
  question?: string;
  options?: unknown[];
  correctIndexes?: unknown[];
  modelAnswer?: string;
  explanation?: string;
  subtopic?: string;
}

interface QuizQuestion {
  type: QuestionType;
  question: string;
  options: string[];
  correctIndexes: number[];
  modelAnswer: string;
  explanation: string;
  subtopic: string;
}

interface DiagnoseResult {
  onTopic: boolean;
  topic: string;
  diagnosis: string;
  questions: QuizQuestion[];
}

const PORT = Number(process.env.PORT) || 3000;
const AI_TIMEOUT_MS = 16_000;
const GEMINI_MODEL_CHAIN = [
  'gemini-3.1-flash-lite',
] as const;
const GEMINI_ADMIN_OCR_MODEL_CHAIN = [
  'gemini-3.1-flash-lite',
  'gemini-4-hydrogen',
] as const;
const MAX_AI_ATTEMPTS = 2;
const BASE_BACKOFF_MS = 500;

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

interface GeminiErrorDetails {
  status: number | null;
  message: string;
  isTimeout: boolean;
  isRetryable: boolean;
  retryDelayMs: number | null;
  isDailyQuota: boolean;
}

function sanitizeErrorMessage(raw: string): string {
  return raw
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRetryDelayMsFromString(text: string): number | null {
  const retryInMatch = text.match(/retry\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds|m|min|minutes)?/i);
  if (retryInMatch) {
    const val = Number(retryInMatch[1]);
    const unit = (retryInMatch[2] || 's').toLowerCase();
    if (Number.isFinite(val) && val > 0) {
      if (unit === 'ms') return Math.ceil(val);
      if (unit.startsWith('m')) return Math.ceil(val * 60_000);
      return Math.ceil(val * 1_000);
    }
  }
  const jsonDelayMatch = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (jsonDelayMatch) {
    const secs = Number(jsonDelayMatch[1]);
    if (Number.isFinite(secs) && secs > 0) {
      return Math.ceil(secs * 1_000);
    }
  }
  return null;
}

function extractGeminiErrorDetails(err: unknown): GeminiErrorDetails {
  const rawMessage = err instanceof Error ? err.message : String(err ?? 'Unknown AI error');
  const isTimeout =
    rawMessage === 'AI_TIMEOUT' ||
    rawMessage.toLowerCase().includes('abort') ||
    rawMessage.toLowerCase().includes('timed out') ||
    rawMessage.toLowerCase().includes('timeout');

  let status: number | null = null;
  if (typeof err === 'object' && err !== null) {
    const rec = err as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      error?: { code?: unknown; status?: unknown };
    };
    const candidates = [rec.status, rec.statusCode, rec.code, rec.error?.code];
    for (const c of candidates) {
      if (typeof c === 'number' && c >= 100 && c <= 599) {
        status = c;
        break;
      }
      if (typeof c === 'string' && /^\d{3}$/.test(c)) {
        status = Number(c);
        break;
      }
    }
  }

  let parsedMsg = rawMessage;
  let retryDelayMs: number | null = parseRetryDelayMsFromString(rawMessage);
  let quotaDetailsText = rawMessage;

  if (rawMessage.startsWith('{') || rawMessage.includes('"error"')) {
    try {
      const jsonStart = rawMessage.indexOf('{');
      if (jsonStart >= 0) {
        const parsed = JSON.parse(rawMessage.slice(jsonStart)) as {
          error?: {
            code?: number;
            status?: string;
            message?: string;
            details?: Array<{
              retryDelay?: string;
              violations?: Array<{ quotaId?: string; quotaMetric?: string }>;
            }>;
          };
          message?: string;
        };
        if (typeof parsed?.error?.code === 'number' && status === null) {
          status = parsed.error.code;
        }
        if (typeof parsed?.error?.message === 'string') {
          parsedMsg = parsed.error.message;
        } else if (typeof parsed?.message === 'string') {
          parsedMsg = parsed.message;
        }
        if (Array.isArray(parsed?.error?.details)) {
          quotaDetailsText += ' ' + JSON.stringify(parsed.error.details);
          for (const d of parsed.error.details) {
            if (typeof d?.retryDelay === 'string' && retryDelayMs === null) {
              const secMatch = d.retryDelay.match(/^(\d+(?:\.\d+)?)s$/i);
              if (secMatch) {
                retryDelayMs = Math.ceil(Number(secMatch[1]) * 1_000);
              }
            }
          }
        }
      }
    } catch {
      // Keep rawMessage when not valid JSON
    }
  }

  if (status === null) {
    const statusMatch = rawMessage.match(/\b(400|401|403|404|408|429|500|502|503|504)\b/);
    if (statusMatch) {
      status = Number(statusMatch[1]);
    }
  }

  const cleanMsg = sanitizeErrorMessage(parsedMsg) || 'Unknown AI error';
  const upperMsg = cleanMsg.toUpperCase();
  const isDailyQuota =
    (status === 429 || upperMsg.includes('RESOURCE_EXHAUSTED') || upperMsg.includes('QUOTA')) &&
    /perday|per_day|per day|daily/i.test(quotaDetailsText) &&
    !/perminute|per_minute|per minute/i.test(quotaDetailsText);

  const isRetryable =
    !isTimeout &&
    status !== 404 &&
    !isDailyQuota &&
    (status === 429 ||
      status === 500 ||
      status === 503 ||
      upperMsg.includes('RESOURCE_EXHAUSTED') ||
      upperMsg.includes('UNAVAILABLE') ||
      upperMsg.includes('OVERLOADED') ||
      upperMsg.includes('ECONNRESET') ||
      upperMsg.includes('FETCH FAILED'));

  return {
    status: isTimeout && status === null ? 504 : status,
    message: cleanMsg,
    isTimeout,
    isRetryable,
    retryDelayMs,
    isDailyQuota,
  };
}

function formatShortPublicAiError(details: GeminiErrorDetails): string {
  if (details.isTimeout) {
    return 'The AI service took too long to respond. Please try again.';
  }
  if (details.status === 429 || details.message.toUpperCase().includes('RESOURCE_EXHAUSTED')) {
    if (details.isDailyQuota) {
      return 'The AI service has reached its daily usage limit. Please try again later.';
    }
    return 'The AI service is temporarily busy after processing several files. Please wait a minute and try again.';
  }
  if (details.status === 503 || details.status === 500) {
    return 'The AI service is temporarily unavailable. Please try again in a moment.';
  }
  const withoutUrls = details.message.replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
  const shortMsg = withoutUrls.length > 140 ? `${withoutUrls.slice(0, 137)}...` : withoutUrls;
  return shortMsg || 'The AI service could not complete this request. Please try again.';
}

function stripJsonCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGeminiWithRetryAndFallback(params: {
  route: string;
  contents: string | Record<string, unknown> | Array<Record<string, unknown>>;
  systemInstruction: string;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  modelChain?: readonly string[];
  timeoutMs?: number;
  respectRetryDelayOn429?: boolean;
}): Promise<{ text: string; model: string }> {
  const ai = getAiClient();
  const modelChain = params.modelChain ?? GEMINI_MODEL_CHAIN;
  const timeoutMs = params.timeoutMs ?? AI_TIMEOUT_MS;
  const maxAttempts = params.respectRetryDelayOn429 ? 3 : MAX_AI_ATTEMPTS;
  let lastDetails: GeminiErrorDetails = {
    status: 502,
    message: 'AI service error',
    isTimeout: false,
    isRetryable: true,
    retryDelayMs: null,
    isDailyQuota: false,
  };

  for (const model of modelChain) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), timeoutMs);

      try {
        const config: Record<string, unknown> = {
          systemInstruction: params.systemInstruction,
          abortSignal: abortController.signal,
        };
        if (model.startsWith('gemini-3')) {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };
        } else if (model.startsWith('gemini-4')) {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
        }
        if (params.responseMimeType) {
          config.responseMimeType = params.responseMimeType;
        }
        if (params.responseSchema) {
          config.responseSchema = params.responseSchema;
        }

        const aiPromise = ai.models.generateContent({
          model,
          contents: params.contents,
          config,
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          abortController.signal.addEventListener(
            'abort',
            () => reject(new Error('AI_TIMEOUT')),
            { once: true }
          );
        });

        const response = await Promise.race([aiPromise, timeoutPromise]);
        clearTimeout(timer);

        const rawText = (response.text ?? '').trim();
        if (!rawText) {
          throw new Error('Empty AI response from Gemini');
        }
        return { text: rawText, model };
      } catch (err) {
        clearTimeout(timer);
        const details = extractGeminiErrorDetails(err);
        lastDetails = details;

        console.error(
          `[Gemini][${params.route}] model=${model} attempt=${attempt}/${maxAttempts} status=${details.status ?? 'unknown'} message=${details.message}`
        );

        // Move to the next model right away on timeout or 404 without retrying the same model
        if (details.isTimeout || details.status === 404) {
          break;
        }
        if (details.isRetryable && attempt < maxAttempts) {
          const backoff =
            params.respectRetryDelayOn429 && details.status === 429
              ? Math.min(Math.max((details.retryDelayMs ?? 12_000 * attempt) + 1_500, 4_000), 65_000)
              : BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
          await delayMs(backoff);
          continue;
        }
        break;
      }
    }
  }

  const finalError = new Error(formatShortPublicAiError(lastDetails)) as Error & {
    httpStatus?: number;
    isPublicAiError?: boolean;
  };
  finalError.httpStatus = lastDetails.isTimeout
    ? 504
    : lastDetails.status === 429 || lastDetails.status === 503
      ? lastDetails.status
      : 502;
  finalError.isPublicAiError = true;
  throw finalError;
}

function sendAiErrorResponse(res: express.Response, route: string, err: unknown): void {
  const details = extractGeminiErrorDetails(err);
  const httpStatus =
    typeof (err as { httpStatus?: unknown })?.httpStatus === 'number'
      ? (err as { httpStatus: number }).httpStatus
      : details.isTimeout
        ? 504
        : details.status === 429
          ? 429
          : 502;
  const isTaggedPublic = Boolean((err as { isPublicAiError?: unknown })?.isPublicAiError);
  const publicError =
    isTaggedPublic && err instanceof Error
      ? err.message
      : formatShortPublicAiError(details);
  console.error(`[Gemini][${route}] failed status=${httpStatus} error=${publicError}`);
  res.status(httpStatus).json({
    ok: false,
    error: publicError,
  });
}

const QUESTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    type: {
      type: Type.STRING,
      description: 'Question type: "single", "multiple", or "written".',
    },
    question: { type: Type.STRING },
    options: {
      type: Type.ARRAY,
      description: '4 option strings for "single" or "multiple"; empty array [] for "written".',
      items: { type: Type.STRING },
    },
    correctIndexes: {
      type: Type.ARRAY,
      description:
        'Zero-based correct option indexes: 1 index for "single", 2 or more indexes for "multiple", empty array [] for "written".',
      items: { type: Type.INTEGER },
    },
    modelAnswer: {
      type: Type.STRING,
      description: 'Short model answer for "written" questions; empty string "" for "single" or "multiple".',
    },
    explanation: { type: Type.STRING },
    subtopic: { type: Type.STRING },
  },
  required: [
    'type',
    'question',
    'options',
    'correctIndexes',
    'modelAnswer',
    'explanation',
    'subtopic',
  ],
};

function normalizeQuestions(rawList: unknown, fallbackTopic: string): QuizQuestion[] {
  const list = Array.isArray(rawList) ? (rawList as RawQuizQuestion[]).slice(0, 10) : [];
  return list.map((q) => {
    const rawType = String(q.type || 'single').toLowerCase().trim();
    const initialType: QuestionType =
      rawType === 'multiple' || rawType === 'written' ? rawType : 'single';

    if (initialType === 'written') {
      return {
        type: 'written',
        question: String(q.question || ''),
        options: [],
        correctIndexes: [],
        modelAnswer: String(q.modelAnswer || q.explanation || ''),
        explanation: String(q.explanation || ''),
        subtopic: String(q.subtopic || fallbackTopic || 'General'),
      };
    }

    const opts = Array.isArray(q.options) ? q.options.slice(0, 4).map(String) : [];
    while (opts.length < 4) {
      opts.push('N/A');
    }

    const validIndexes = Array.from(
      new Set(
        (Array.isArray(q.correctIndexes) ? q.correctIndexes : [])
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < opts.length)
      )
    ).sort((a, b) => a - b);

    if (initialType === 'multiple') {
      if (validIndexes.length >= 2) {
        return {
          type: 'multiple',
          question: String(q.question || ''),
          options: opts,
          correctIndexes: validIndexes,
          modelAnswer: '',
          explanation: String(q.explanation || ''),
          subtopic: String(q.subtopic || fallbackTopic || 'General'),
        };
      }
      // Fallback to single if model returned fewer than 2 valid indexes
      return {
        type: 'single',
        question: String(q.question || ''),
        options: opts,
        correctIndexes: [validIndexes[0] ?? 0],
        modelAnswer: '',
        explanation: String(q.explanation || ''),
        subtopic: String(q.subtopic || fallbackTopic || 'General'),
      };
    }

    return {
      type: 'single',
      question: String(q.question || ''),
      options: opts,
      correctIndexes: [validIndexes[0] ?? 0],
      modelAnswer: '',
      explanation: String(q.explanation || ''),
      subtopic: String(q.subtopic || fallbackTopic || 'General'),
    };
  });
}

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIM = 768;

async function extractPdfTextWithPdfJs(
  pdfBuffer: Buffer
): Promise<{ text: string; pageCount: number }> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    verbosity: 0,
  });

  const pdfDoc = await loadingTask.promise;
  const pageCount = pdfDoc.numPages || 0;
  const pageTexts: string[] = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await pdfDoc.getPage(p);
    const content = await page.getTextContent();
    const lines: string[] = [];
    let currentLine = '';

    for (const rawItem of content.items) {
      if (!rawItem || typeof rawItem !== 'object' || !('str' in rawItem)) continue;
      const item = rawItem as { str: string; hasEOL?: boolean };
      const piece = item.str || '';
      currentLine += piece;
      if (item.hasEOL) {
        if (currentLine.trim()) lines.push(currentLine.trim());
        currentLine = '';
      } else if (piece && !piece.endsWith(' ')) {
        currentLine += ' ';
      }
    }
    if (currentLine.trim()) lines.push(currentLine.trim());
    const joinedPage = lines.join('\n').trim();
    if (joinedPage) {
      pageTexts.push(`[Page ${p}]\n${joinedPage}`);
    }
  }

  const maybeDestroy = (pdfDoc as unknown as { destroy?: () => Promise<void> }).destroy;
  if (typeof maybeDestroy === 'function') {
    await maybeDestroy.call(pdfDoc);
  }
  return {
    text: pageTexts.join('\n\n').trim(),
    pageCount,
  };
}

async function extractPdfTextWithGeminiMultimodal(
  cleanBase64: string,
  fileName: string,
  allowAdminOcrFallback = false
): Promise<string> {
  const { text } = await callGeminiWithRetryAndFallback({
    route: '/api/materials/ingest-ocr',
    contents: {
      parts: [
        { inlineData: { mimeType: 'application/pdf', data: cleanBase64 } },
        {
          text: `Extract ALL readable instructional text, slide titles, definitions, formulas, diagrams text, and key examples from this course PDF ("${fileName}"). Preserve section headings and slide order cleanly as plain text. Do not invent content that is not on the pages.`,
        },
      ],
    },
    systemInstruction:
      'You are an accurate academic document OCR and text extractor. Return only the extracted plain text content from the PDF.',
    modelChain: allowAdminOcrFallback ? GEMINI_ADMIN_OCR_MODEL_CHAIN : GEMINI_MODEL_CHAIN,
    timeoutMs: allowAdminOcrFallback ? 45_000 : AI_TIMEOUT_MS,
    respectRetryDelayOn429: allowAdminOcrFallback,
  });
  return text.trim();
}

function splitTextIntoOverlappingChunks(
  rawText: string,
  chunkSize = 800,
  overlap = 100
): string[] {
  const normalized = rawText
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) return [];
  if (normalized.length <= chunkSize) return [normalized];

  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);

    if (end < normalized.length) {
      const slice = normalized.slice(start, end);
      const lastParagraph = slice.lastIndexOf('\n\n');
      const lastNewline = slice.lastIndexOf('\n');
      const lastSpace = slice.lastIndexOf(' ');
      if (lastParagraph >= Math.floor(chunkSize * 0.55)) {
        end = start + lastParagraph;
      } else if (lastNewline >= Math.floor(chunkSize * 0.65)) {
        end = start + lastNewline;
      } else if (lastSpace >= Math.floor(chunkSize * 0.7)) {
        end = start + lastSpace;
      }
    }

    const piece = normalized.slice(start, end).trim();
    if (piece) {
      chunks.push(piece);
    }

    if (end >= normalized.length) break;

    let nextStart = Math.max(0, end - overlap);
    if (nextStart <= start) {
      nextStart = end;
    } else if (nextStart > 0 && normalized[nextStart - 1] !== ' ' && normalized[nextStart] !== ' ') {
      const nextSpace = normalized.indexOf(' ', nextStart);
      if (nextSpace !== -1 && nextSpace < end) {
        nextStart = nextSpace + 1;
      }
    }
    start = nextStart;
  }

  return chunks;
}

const EMBED_RATE_WINDOW_MS = 62_000;
const EMBED_MAX_ITEMS_PER_WINDOW = 75;
const EMBED_MAX_TOKENS_PER_WINDOW = 22_000;
const EMBED_INTER_BATCH_PAUSE_MS = 300;
const MAX_EMBED_BATCH_ATTEMPTS = 5;

interface EmbedUsageRecord {
  ts: number;
  items: number;
  tokens: number;
}

const embedUsageHistory: EmbedUsageRecord[] = [];
let embedBatchLock: Promise<void> = Promise.resolve();

function estimateEmbeddingTokens(texts: string[]): number {
  return texts.reduce((sum, t) => sum + Math.max(1, Math.ceil(t.length / 3.5)), 0);
}

function pruneEmbedUsage(now: number): void {
  const cutoff = now - EMBED_RATE_WINDOW_MS;
  while (embedUsageHistory.length > 0 && embedUsageHistory[0].ts <= cutoff) {
    embedUsageHistory.shift();
  }
}

async function waitForEmbedBudget(itemsNeeded: number, tokensNeeded: number): Promise<void> {
  while (true) {
    const now = Date.now();
    pruneEmbedUsage(now);

    const usedItems = embedUsageHistory.reduce((acc, r) => acc + r.items, 0);
    const usedTokens = embedUsageHistory.reduce((acc, r) => acc + r.tokens, 0);

    const itemsOk = usedItems === 0 || usedItems + itemsNeeded <= EMBED_MAX_ITEMS_PER_WINDOW;
    const tokensOk = usedTokens === 0 || usedTokens + tokensNeeded <= EMBED_MAX_TOKENS_PER_WINDOW;
    if (itemsOk && tokensOk) {
      return;
    }

    const oldestTs = embedUsageHistory[0]?.ts ?? now;
    const waitMs = Math.max(500, Math.min(oldestTs + EMBED_RATE_WINDOW_MS - now + 350, 62_000));
    console.log(
      `[Gemini][embedContent] Rate-limit pacing: used=${usedItems} items / ${usedTokens} est tokens; waiting ${waitMs}ms before next batch`
    );
    await delayMs(waitMs);
  }
}

function recordEmbedUsage(items: number, tokens: number): void {
  const now = Date.now();
  pruneEmbedUsage(now);
  embedUsageHistory.push({ ts: now, items, tokens });
}

async function withEmbedBatchLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = embedBatchLock;
  let release!: () => void;
  embedBatchLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function runEmbedTextsInternal(
  texts: string[],
  priority: 'interactive' | 'batch'
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const ai = getAiClient();
  const BATCH_SIZE = priority === 'batch' ? 10 : 12;
  const maxAttempts = priority === 'batch' ? MAX_EMBED_BATCH_ATTEMPTS : MAX_AI_ATTEMPTS;
  const timeoutMs = priority === 'batch' ? 25_000 : AI_TIMEOUT_MS;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const estTokens = estimateEmbeddingTokens(batch);

    if (priority === 'batch') {
      if (i > 0) {
        await delayMs(EMBED_INTER_BATCH_PAUSE_MS);
      }
      await waitForEmbedBudget(batch.length, estTokens);
    }

    let batchVectors: number[][] | null = null;
    let lastDetails: GeminiErrorDetails = {
      status: 502,
      message: 'Embedding request failed',
      isTimeout: false,
      isRetryable: true,
      retryDelayMs: null,
      isDailyQuota: false,
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), timeoutMs);

      try {
        const embedPromise = ai.models.embedContent({
          model: EMBEDDING_MODEL,
          contents: batch,
          config: {
            outputDimensionality: EMBEDDING_DIM,
            abortSignal: abortController.signal,
          },
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          abortController.signal.addEventListener(
            'abort',
            () => reject(new Error('AI_TIMEOUT')),
            { once: true }
          );
        });

        const response = await Promise.race([embedPromise, timeoutPromise]);
        clearTimeout(timer);

        const vectors = (response.embeddings ?? []).map((item) =>
          Array.isArray(item.values) ? item.values.map((v) => Number(v)) : []
        );
        if (vectors.length !== batch.length || vectors.some((v) => v.length !== EMBEDDING_DIM)) {
          throw new Error('Incomplete embedding vectors returned by Gemini');
        }
        recordEmbedUsage(batch.length, estTokens);
        batchVectors = vectors;
        break;
      } catch (err) {
        clearTimeout(timer);
        const details = extractGeminiErrorDetails(err);
        lastDetails = details;
        console.error(
          `[Gemini][embedContent] model=${EMBEDDING_MODEL} attempt=${attempt}/${maxAttempts} status=${details.status ?? 'unknown'} retryDelayMs=${details.retryDelayMs ?? 'none'} dailyQuota=${details.isDailyQuota} message=${details.message}`
        );

        if (details.isTimeout || details.status === 404 || details.isDailyQuota) {
          break;
        }
        if (details.isRetryable && attempt < maxAttempts) {
          let backoff: number;
          if (priority === 'batch' && details.status === 429) {
            const suggested = details.retryDelayMs ?? Math.min(12_000 * attempt, 55_000);
            backoff = Math.min(Math.max(suggested + 1_500, 5_000), 65_000);
            console.log(
              `[Gemini][embedContent] Hit 429 rate limit during batch upload; waiting ${backoff}ms before retry ${attempt + 1}/${maxAttempts}`
            );
          } else {
            backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
          }
          await delayMs(backoff);
          continue;
        }
        break;
      }
    }

    if (!batchVectors) {
      const finalErr = new Error(formatShortPublicAiError(lastDetails)) as Error & {
        httpStatus?: number;
        isPublicAiError?: boolean;
      };
      finalErr.httpStatus = lastDetails.isTimeout ? 504 : lastDetails.status || 502;
      finalErr.isPublicAiError = true;
      throw finalErr;
    }

    allEmbeddings.push(...batchVectors);
  }

  return allEmbeddings;
}

async function embedTextsWithRetry(
  texts: string[],
  options?: { priority?: 'interactive' | 'batch' }
): Promise<number[][]> {
  const priority = options?.priority ?? 'interactive';
  if (priority === 'batch') {
    return withEmbedBatchLock(() => runEmbedTextsInternal(texts, 'batch'));
  }
  return runEmbedTextsInternal(texts, 'interactive');
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_FILES = 3;
const MAX_ATTACHMENT_TEXT_CHARS = 30_000;

async function extractImageTextWithGeminiMultimodal(
  cleanBase64: string,
  mimeType: 'image/png' | 'image/jpeg',
  fileName: string
): Promise<string> {
  const { text } = await callGeminiWithRetryAndFallback({
    route: '/api/attachments/extract-image',
    contents: {
      parts: [
        { inlineData: { mimeType, data: cleanBase64 } },
        {
          text: `Read and transcribe all text, equations, code snippets, terminal outputs, error messages, and diagram labels visible in this student-uploaded screenshot/image ("${fileName}"). Preserve formatting cleanly as plain text. If there is little or no text, briefly describe the visual problem shown.`,
        },
      ],
    },
    systemInstruction:
      'You are an accurate academic screenshot reader. Return only the extracted text and factual visual description from the image.',
  });
  return text.trim();
}

function normalizeCourseCodeServer(raw: string): string {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

function cosineSimilarityServer(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function isLegacyMockChunkServer(fileName: string, text: string): boolean {
  const f = fileName.trim();
  const t = text.trim();
  if (t.length < 30 && /^CIS1813\s+(Number Systems|OSI Model|CIA Triad|Subnetting)/i.test(t)) {
    return true;
  }
  if (/^cis1813[-_]mock/i.test(f)) return true;
  return false;
}

const COURSE_RAG_CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedServerChunk {
  fileName: string;
  topic: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
  embeddingModel: string;
  embeddingDim: number;
}

interface CourseRagCacheEntry {
  chunks: CachedServerChunk[];
  topicTitles: string[];
  cachedAt: number;
}

const courseRagCache = new Map<string, CourseRagCacheEntry>();

function invalidateCourseRagCache(courseCode?: string): void {
  const normalized = courseCode ? normalizeCourseCodeServer(courseCode) : '';
  if (normalized) {
    courseRagCache.delete(normalized);
    console.log(`[ServerRAG] Invalidated cache for course=${normalized}`);
  } else {
    courseRagCache.clear();
    console.log('[ServerRAG] Invalidated all course caches');
  }
}

function extractEmbeddingArray(raw: unknown): number[] {
  let list: unknown[] | null = null;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object' && typeof (raw as { toArray?: unknown }).toArray === 'function') {
    try {
      const converted = (raw as { toArray: () => unknown[] }).toArray();
      if (Array.isArray(converted)) {
        list = converted;
      }
    } catch {
      list = null;
    }
  }
  if (!list) return [];
  return list.map((v) => Number(v)).filter((v) => Number.isFinite(v));
}

function cleanFileTopicFallback(fileName: string, fallbackCourse: string): string {
  return fileName.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || fallbackCourse;
}

async function getCachedCourseRagData(
  normalizedCourse: string,
  reauth = false
): Promise<CourseRagCacheEntry> {
  const existing = courseRagCache.get(normalizedCourse);
  if (existing && Date.now() - existing.cachedAt < COURSE_RAG_CACHE_TTL_MS) {
    return existing;
  }

  try {
    const db = await getServerFirestore(reauth);
    const [materialsSnap, chunksSnap] = await Promise.all([
      getDocs(query(collection(db, 'materials'), where('courseCode', '==', normalizedCourse))),
      getDocs(query(collection(db, 'chunks'), where('courseCode', '==', normalizedCourse))),
    ]);

    const materialTopicById = new Map<string, string>();
    const materialTopicByFileName = new Map<string, string>();
    const topicTitleSet = new Set<string>();

    materialsSnap.forEach((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      const fileName = typeof data.fileName === 'string' ? data.fileName.trim() : '';
      const rawTopic = typeof data.topicTitle === 'string' ? data.topicTitle.trim() : '';
      const status = typeof data.status === 'string' ? data.status : '';
      if (isLegacyMockChunkServer(fileName, rawTopic || fileName)) return;
      const topic = rawTopic || cleanFileTopicFallback(fileName, normalizedCourse);
      if (topic) {
        materialTopicById.set(docSnap.id, topic);
        if (fileName) {
          materialTopicByFileName.set(fileName.toLowerCase(), topic);
        }
        if (status === 'indexed' || !status) {
          topicTitleSet.add(topic);
        }
      }
    });

    const items: CachedServerChunk[] = [];
    chunksSnap.forEach((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      const fileName = typeof data.fileName === 'string' ? data.fileName.trim() : '';
      if (!text || isLegacyMockChunkServer(fileName, text)) return;
      const materialId = typeof data.materialId === 'string' ? data.materialId.trim() : '';
      const chunkIndex = typeof data.chunkIndex === 'number' ? data.chunkIndex : 0;
      const embedding = extractEmbeddingArray(data.embedding);
      const embeddingModel =
        typeof data.embeddingModel === 'string' ? data.embeddingModel.trim() : '';
      const embeddingDim =
        typeof data.embeddingDim === 'number' && Number.isFinite(data.embeddingDim)
          ? data.embeddingDim
          : embedding.length;

      const topic =
        (materialId && materialTopicById.get(materialId)) ||
        (fileName && materialTopicByFileName.get(fileName.toLowerCase())) ||
        cleanFileTopicFallback(fileName, normalizedCourse);

      if (topic) {
        topicTitleSet.add(topic);
      }

      items.push({
        fileName,
        topic,
        chunkIndex,
        text,
        embedding,
        embeddingModel,
        embeddingDim,
      });
    });

    const entry: CourseRagCacheEntry = {
      chunks: items,
      topicTitles: Array.from(topicTitleSet),
      cachedAt: Date.now(),
    };
    courseRagCache.set(normalizedCourse, entry);
    return entry;
  } catch (err) {
    if (!reauth) {
      return getCachedCourseRagData(normalizedCourse, true);
    }
    throw err;
  }
}

async function retrieveCourseNotesFromServer(params: {
  course: string;
  queryText: string;
  limitCount?: number;
}): Promise<{ notes: CourseNoteInput[]; allTopicTitles: string[] }> {
  const normalizedCourse = normalizeCourseCodeServer(params.course);
  if (!normalizedCourse) return { notes: [], allTopicTitles: [] };
  const limitCount = params.limitCount ?? 12;

  const { chunks, topicTitles } = await getCachedCourseRagData(normalizedCourse);
  if (chunks.length === 0) {
    console.log(`[ServerRAG] course=${normalizedCourse} chunks=0 top5=[]`);
    return { notes: [], allTopicTitles: topicTitles };
  }

  const qText = params.queryText.trim();
  let queryVec: number[] = [];
  if (qText) {
    try {
      const vectors = await embedTextsWithRetry([qText], { priority: 'interactive' });
      queryVec = vectors[0] || [];
    } catch (err) {
      console.warn('[ServerRAG] Query embedding failed, using keyword fallback:', err);
    }
  }

  const queryTerms = Array.from(
    new Set(
      qText
        .toLowerCase()
        .split(/[^a-z0-9\u0600-\u06FF]+/)
        .filter((w) => w.length >= 3)
    )
  );

  const scored = chunks.map((chunk) => {
    const modelMatches =
      queryVec.length === EMBEDDING_DIM &&
      chunk.embeddingModel === EMBEDDING_MODEL &&
      chunk.embeddingDim === EMBEDDING_DIM &&
      chunk.embedding.length === EMBEDDING_DIM;
    const vectorScore = modelMatches ? cosineSimilarityServer(queryVec, chunk.embedding) : 0;

    let keywordScore = 0;
    if (queryTerms.length > 0) {
      const hay = `${chunk.fileName} ${chunk.topic} ${chunk.text}`.toLowerCase();
      keywordScore = queryTerms.reduce((acc, term) => (hay.includes(term) ? acc + 1 : acc), 0);
    }

    return { chunk, vectorScore, keywordScore };
  });

  const maxVectorScore = scored.reduce(
    (max, item) => (item.vectorScore > max ? item.vectorScore : max),
    0
  );
  const useKeywordsOnly = queryVec.length === 0 || maxVectorScore <= 0;

  const ranked = scored
    .map((item) => ({
      chunk: item.chunk,
      score: useKeywordsOnly
        ? item.keywordScore
        : item.vectorScore + item.keywordScore * 0.05,
    }))
    .sort((a, b) => b.score - a.score || a.chunk.chunkIndex - b.chunk.chunkIndex);

  const top5Summary = ranked
    .slice(0, 5)
    .map((r) => `${r.chunk.fileName || r.chunk.topic}(${r.score.toFixed(3)})`)
    .join(', ');
  console.log(
    `[ServerRAG] course=${normalizedCourse} chunks=${chunks.length} top5=[${top5Summary}]`
  );

  return {
    notes: ranked.slice(0, limitCount).map(({ chunk }) => ({
      course: normalizedCourse,
      topic: chunk.topic,
      fileName: chunk.fileName,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
    })),
    allTopicTitles: topicTitles,
  };
}

function formatCourseNotesForPrompt(notes: CourseNoteInput[]): string {
  return notes
    .map((n, index) => {
      const sourceLabel = n.fileName || n.topic || `Course Material ${index + 1}`;
      return `--- Source: ${sourceLabel} ---\n${n.text}`;
    })
    .join('\n\n');
}

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '45mb' }));

  app.get('/api/courses', async (_req, res) => {
    try {
      let snap;
      try {
        const db = await getServerFirestore(false);
        snap = await getDocs(collection(db, 'courses'));
      } catch {
        const db = await getServerFirestore(true);
        snap = await getDocs(collection(db, 'courses'));
      }

      const courses: Array<{
        id: string;
        code: string;
        title: string;
        department?: string;
        active: boolean;
      }> = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        const code = typeof data.code === 'string' ? data.code.trim().toUpperCase() : '';
        const title = typeof data.title === 'string' ? data.title.trim() : '';
        const active = data.active !== false;
        if (!code || !title || !active) return;
        courses.push({
          id: docSnap.id,
          code,
          title,
          department: typeof data.department === 'string' ? data.department.trim() : undefined,
          active,
        });
      });

      courses.sort((a, b) => a.code.localeCompare(b.code));
      res.json({ ok: true, courses });
    } catch (err) {
      console.error('[ServerCourses] Failed to load courses:', err);
      res.status(500).json({ ok: false, error: 'Could not load courses.' });
    }
  });

  app.post('/api/attachments/extract', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const body = req.body as {
      files?: Array<{
        fileName?: string;
        mimeType?: string;
        base64Data?: string;
        size?: number;
      }>;
    };

    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) {
      res.status(400).json({ ok: false, error: 'No files provided.' });
      return;
    }
    if (files.length > MAX_ATTACHMENT_FILES) {
      res.status(400).json({
        ok: false,
        error: `You can attach up to ${MAX_ATTACHMENT_FILES} files per request.`,
      });
      return;
    }

    try {
      const results: Array<{
        fileName: string;
        mimeType: 'image/png' | 'image/jpeg' | 'application/pdf';
        size: number;
        extractedText: string;
      }> = [];

      for (const item of files) {
        const fileName = typeof item.fileName === 'string' ? item.fileName.trim() : 'attachment';
        const rawMime = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
        const normalizedMime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;

        if (
          normalizedMime !== 'image/png' &&
          normalizedMime !== 'image/jpeg' &&
          normalizedMime !== 'application/pdf'
        ) {
          res.status(400).json({
            ok: false,
            error: `Unsupported file type for "${fileName}". Only PNG, JPG/JPEG images, and PDF files are allowed.`,
          });
          return;
        }

        const rawBase64 = typeof item.base64Data === 'string' ? item.base64Data.trim() : '';
        const cleanBase64 = rawBase64.replace(/^data:[^;]+;base64,/, '');
        if (!cleanBase64) {
          res.status(400).json({ ok: false, error: `File "${fileName}" is empty.` });
          return;
        }

        const buf = Buffer.from(cleanBase64, 'base64');
        if (buf.length === 0) {
          res.status(400).json({ ok: false, error: `File "${fileName}" is empty.` });
          return;
        }
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          res.status(400).json({
            ok: false,
            error: `File "${fileName}" exceeds the 10 MB limit.`,
          });
          return;
        }

        let extractedText = '';
        if (normalizedMime === 'application/pdf') {
          if (buf.subarray(0, 5).toString('ascii') !== '%PDF-') {
            res.status(400).json({
              ok: false,
              error: `File "${fileName}" is not a valid PDF document.`,
            });
            return;
          }
          try {
            const parsed = await extractPdfTextWithPdfJs(buf);
            extractedText = parsed.text;
          } catch {
            extractedText = '';
          }
          const alphaLen = extractedText.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '').length;
          if (alphaLen < 40) {
            extractedText = await extractPdfTextWithGeminiMultimodal(cleanBase64, fileName);
          }
        } else {
          extractedText = await extractImageTextWithGeminiMultimodal(
            cleanBase64,
            normalizedMime,
            fileName
          );
        }

        const boundedText = extractedText.trim().slice(0, MAX_ATTACHMENT_TEXT_CHARS);
        results.push({
          fileName: fileName.slice(0, 255),
          mimeType: normalizedMime,
          size: buf.length,
          extractedText: boundedText,
        });
      }

      res.json({ ok: true, attachments: results });
    } catch (err) {
      sendAiErrorResponse(res, '/api/attachments/extract', err);
    }
  });

  app.post('/api/diagnose', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const body = req.body as DiagnoseRequestBody;
    const course = typeof body.course === 'string' ? body.course.trim() : '';
    const studentText = typeof body.studentText === 'string' ? body.studentText.trim() : '';
    const attachmentContext =
      typeof body.attachmentContext === 'string' ? body.attachmentContext.trim() : '';

    if (!course || !studentText) {
      res.status(400).json({
        ok: false,
        error: 'Missing course or studentText.',
      });
      return;
    }

    const ragQuery = [studentText, attachmentContext.slice(0, 1200)].filter(Boolean).join('\n');
    let notes: CourseNoteInput[] = [];
    let allTopicTitles: string[] = [];
    try {
      const ragResult = await retrieveCourseNotesFromServer({
        course,
        queryText: ragQuery,
        limitCount: 12,
      });
      notes = ragResult.notes;
      allTopicTitles = ragResult.allTopicTitles;
    } catch (err) {
      console.error('[ServerRAG][/api/diagnose] Failed to retrieve materials:', err);
      res.status(500).json({
        ok: false,
        error: 'Could not load course materials on the server. Please try again.',
      });
      return;
    }

    if (notes.length === 0) {
      res.status(404).json({
        ok: false,
        error: `No course materials have been uploaded for ${course} yet. Please ask your ASC Coordinator to add course PDFs.`,
      });
      return;
    }

    const studentLang = detectStudentLanguage(studentText);
    const availableTopics =
      allTopicTitles.length > 0
        ? allTopicTitles
        : Array.from(new Set(notes.map((n) => n.topic).filter(Boolean)));
    const formattedNotes = formatCourseNotesForPrompt(notes);

    const prompt = [
      `Course: ${course}`,
      availableTopics.length > 0
        ? `All topics covered in ${course} course materials: ${availableTopics.join(' | ')}`
        : '',
      '',
      'Course Material Excerpts (from uploaded PDF slides & notes):',
      formattedNotes,
      '',
      'Student Question:',
      studentText,
      attachmentContext ? '\nStudent Notes & Attached Files:\n' + attachmentContext.slice(0, 24000) : '',
      '',
      'Instructions:',
      '- Check BOTH the full list of "All topics covered in <course> course materials" above AND the "Course Material Excerpts" above.',
      '- If the student question relates to ANY topic in that topics list OR any concept in the excerpts above, set onTopic to true.',
      '- Set onTopic to false ONLY when the student question is clearly unrelated to all of the course topics and excerpts (for example, asking about a completely different subject or casual non-academic topic).',
      '- When onTopic is false, set topic to "", diagnosis to "", and questions to [].',
      '- When onTopic is true, set topic to a concise 2-5 word topic title describing the matched concept, and write a helpful 2-sentence diagnosis based ONLY on the course materials.',
      '- Decide how many diagnostic questions to ask (between 5 and 10, based on the depth/breadth of the topic) and mix ALL THREE types: "single" (4 options, 1 index in correctIndexes), "multiple" (4 options, 2 or more indexes in correctIndexes), and "written" (empty options [], empty correctIndexes [], concise modelAnswer string).',
      studentLang === 'arabic'
        ? '- STRICT LANGUAGE RULE: The student wrote in Arabic. Write topic, diagnosis, EVERY question, ALL 4 multiple-choice options in every question, modelAnswer, explanation, and subtopic in Modern Standard Arabic ONLY.'
        : '- STRICT LANGUAGE RULE: The student wrote in English. Write topic, diagnosis, EVERY question, ALL 4 multiple-choice options in every question, modelAnswer, explanation, and subtopic strictly in simple English (CEFR B1) ONLY. Do NOT include any Arabic text anywhere in your response.',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const { text: rawText } = await callGeminiWithRetryAndFallback({
        route: '/api/diagnose',
        contents: prompt,
        systemInstruction: buildLanguageSystemInstruction(studentLang),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            onTopic: {
              type: Type.BOOLEAN,
              description: 'True if the student problem matches concepts in the provided course excerpts; otherwise false.',
            },
            topic: {
              type: Type.STRING,
              description: 'Concise 2-5 word topic title from the matched course excerpts, or empty string if off-topic.',
            },
            diagnosis: {
              type: Type.STRING,
              description: 'Exactly 2 clear sentences diagnosing the student misunderstanding based only on the course excerpts.',
            },
            questions: {
              type: Type.ARRAY,
              description: 'Between 5 and 10 mixed-type diagnostic questions when onTopic is true; empty array when onTopic is false.',
              items: QUESTION_SCHEMA,
            },
          },
          required: ['onTopic', 'topic', 'diagnosis', 'questions'],
        },
      });

      const parsed = JSON.parse(stripJsonCodeFences(rawText)) as {
        onTopic?: boolean;
        topic?: string;
        diagnosis?: string;
        questions?: unknown;
      };
      const onTopic = Boolean(parsed.onTopic);

      if (!onTopic) {
        res.json({
          ok: true,
          result: {
            onTopic: false,
            topic: '',
            diagnosis: '',
            questions: [],
          } satisfies DiagnoseResult,
        });
        return;
      }

      const matchedTopic =
        String(parsed.topic || '').trim() ||
        availableTopics[0] ||
        `${course} Core Concepts`;

      const normalizedQuestions = normalizeQuestions(parsed.questions, matchedTopic);
      if (normalizedQuestions.length < 5) {
        console.error('[Gemini][/api/diagnose] AI returned fewer than 5 diagnostic questions:', normalizedQuestions.length);
        res.status(502).json({ ok: false, error: 'AI returned fewer than 5 diagnostic questions.' });
        return;
      }

      res.json({
        ok: true,
        result: {
          onTopic: true,
          topic: matchedTopic,
          diagnosis: String(parsed.diagnosis || ''),
          questions: normalizedQuestions,
        } satisfies DiagnoseResult,
      });
    } catch (err) {
      sendAiErrorResponse(res, '/api/diagnose', err);
    }
  });

  app.post('/api/study-pack', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const body = req.body as {
      course?: string;
      topic?: string;
      studentText?: string;
      attachmentContext?: string;
      weakSubtopics?: string[];
    };

    const course = typeof body.course === 'string' ? body.course.trim() : '';
    const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
    const studentText = typeof body.studentText === 'string' ? body.studentText.trim() : '';
    const attachmentContext =
      typeof body.attachmentContext === 'string' ? body.attachmentContext.trim() : '';
    const weakSubtopics = Array.isArray(body.weakSubtopics) ? body.weakSubtopics.filter(Boolean) : [];

    if (!course) {
      res.status(400).json({ ok: false, error: 'Missing course.' });
      return;
    }

    const ragQuery = [topic, studentText, weakSubtopics.join(', '), attachmentContext.slice(0, 800)]
      .filter(Boolean)
      .join(' ');
    let notes: CourseNoteInput[] = [];
    try {
      const ragResult = await retrieveCourseNotesFromServer({
        course,
        queryText: ragQuery,
        limitCount: 12,
      });
      notes = ragResult.notes;
    } catch (err) {
      console.error('[ServerRAG][/api/study-pack] Failed to retrieve materials:', err);
      res.status(500).json({
        ok: false,
        error: 'Could not load course materials on the server. Please try again.',
      });
      return;
    }

    if (notes.length === 0) {
      res.status(404).json({
        ok: false,
        error: `No course materials have been uploaded for ${course} yet.`,
      });
      return;
    }

    const studentLang = detectStudentLanguage(studentText || topic);
    const formattedNotes = formatCourseNotesForPrompt(notes);

    const focusArea =
      weakSubtopics.length > 0
        ? weakSubtopics.join(', ')
        : topic || 'the core concepts in the notes';

    const prompt = [
      `Course: ${course}`,
      `Main Topic: ${topic || 'Course topic'}`,
      `Weak Sub-topics to focus on: ${focusArea}`,
      studentText ? `Original Student Question (for language matching): ${studentText}` : '',
      attachmentContext ? `Student Notes & Attached Files:\n${attachmentContext.slice(0, 12000)}` : '',
      '',
      'Course Notes:',
      formattedNotes,
      '',
      'Instructions:',
      '- Create a personalized Study Pack using ONLY the provided Course Notes.',
      '- explanation: A clear, simple explanation focusing on the weak sub-topics (MAXIMUM 200 words). End with a plain source citation using ONLY the file name and slide or page number if shown in [Page N] (for example, "Source: Week 1 What is AI.pdf" or "Source: Week 1 What is AI.pdf, Page 3"). Never mention chunks.',
      '- workedExample: A concrete step-by-step worked example from the notes concepts showing how to solve a typical problem. Format with clear line breaks and numbered steps (e.g., "Step 1: ...\\nStep 2: ...\\nStep 3: ...").',
      '- practice: Decide how many practice questions to create (between 5 and 10, based on the topic) targeting the weak sub-topics, mixing ALL THREE types: "single" (4 options, 1 index in correctIndexes), "multiple" (4 options, 2+ indexes in correctIndexes), and "written" (empty options [], empty correctIndexes [], concise modelAnswer string).',
      studentLang === 'arabic'
        ? '- STRICT LANGUAGE RULE: Write explanation, workedExample, and ALL practice questions, options, model answers, explanations, and subtopics in Modern Standard Arabic ONLY.'
        : '- STRICT LANGUAGE RULE: Write explanation, workedExample, and ALL practice questions, options, model answers, explanations, and subtopics strictly in simple English (CEFR B1) ONLY. Do NOT include any Arabic text.',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const { text: rawText } = await callGeminiWithRetryAndFallback({
        route: '/api/study-pack',
        contents: prompt,
        systemInstruction: buildLanguageSystemInstruction(studentLang),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            explanation: {
              type: Type.STRING,
              description: 'Simple explanation of the weak sub-topics, maximum 200 words.',
            },
            workedExample: {
              type: Type.STRING,
              description:
                'Clear step-by-step worked example grounded in the course notes, formatted with newline characters between steps (Step 1:, Step 2:, etc.).',
            },
            practice: {
              type: Type.ARRAY,
              description: 'Between 5 and 10 mixed-type practice questions on the weak sub-topics.',
              items: QUESTION_SCHEMA,
            },
          },
          required: ['explanation', 'workedExample', 'practice'],
        },
      });

      const parsed = JSON.parse(stripJsonCodeFences(rawText)) as {
        explanation?: string;
        workedExample?: string;
        practice?: unknown;
      };

      const practice = normalizeQuestions(parsed.practice, topic);
      if (practice.length < 5) {
        console.error('[Gemini][/api/study-pack] AI returned fewer than 5 practice questions:', practice.length);
        res.status(502).json({ ok: false, error: 'AI returned fewer than 5 practice questions.' });
        return;
      }

      res.json({
        ok: true,
        result: {
          explanation: String(parsed.explanation || ''),
          workedExample: String(parsed.workedExample || ''),
          practice,
        },
      });
    } catch (err) {
      sendAiErrorResponse(res, '/api/study-pack', err);
    }
  });

  app.post('/api/retest', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const body = req.body as {
      course?: string;
      topic?: string;
      studentText?: string;
      attachmentContext?: string;
      weakSubtopics?: string[];
      previousQuestions?: string[];
    };

    const course = typeof body.course === 'string' ? body.course.trim() : '';
    const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
    const studentText = typeof body.studentText === 'string' ? body.studentText.trim() : '';
    const attachmentContext =
      typeof body.attachmentContext === 'string' ? body.attachmentContext.trim() : '';
    const weakSubtopics = Array.isArray(body.weakSubtopics) ? body.weakSubtopics.filter(Boolean) : [];
    const previousQuestions = Array.isArray(body.previousQuestions)
      ? body.previousQuestions.filter(Boolean)
      : [];

    if (!course) {
      res.status(400).json({ ok: false, error: 'Missing course.' });
      return;
    }

    const ragQuery = [topic, studentText, weakSubtopics.join(', '), attachmentContext.slice(0, 800)]
      .filter(Boolean)
      .join(' ');
    let notes: CourseNoteInput[] = [];
    try {
      const ragResult = await retrieveCourseNotesFromServer({
        course,
        queryText: ragQuery,
        limitCount: 12,
      });
      notes = ragResult.notes;
    } catch (err) {
      console.error('[ServerRAG][/api/retest] Failed to retrieve materials:', err);
      res.status(500).json({
        ok: false,
        error: 'Could not load course materials on the server. Please try again.',
      });
      return;
    }

    if (notes.length === 0) {
      res.status(404).json({
        ok: false,
        error: `No course materials have been uploaded for ${course} yet.`,
      });
      return;
    }

    const studentLang = detectStudentLanguage(studentText || topic);
    const formattedNotes = formatCourseNotesForPrompt(notes);

    const focusArea =
      weakSubtopics.length > 0
        ? weakSubtopics.join(', ')
        : topic || 'the core concepts in the notes';

    const prompt = [
      `Course: ${course}`,
      `Main Topic: ${topic || 'Course topic'}`,
      `Weak Sub-topics to retest: ${focusArea}`,
      studentText ? `Original Student Question (for language matching): ${studentText}` : '',
      attachmentContext ? `Student Notes & Attached Files:\n${attachmentContext.slice(0, 8000)}` : '',
      '',
      'Course Notes:',
      formattedNotes,
      '',
      previousQuestions.length > 0
        ? `Previous Questions (DO NOT repeat or slightly reword these — write brand-new scenarios/numbers/angles):\n${previousQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
        : '',
      '',
      'Instructions:',
      '- Decide how many NEW retest questions to ask (between 5 and 10, based on the topic) based ONLY on the Course Notes and focusing on the Weak Sub-topics above.',
      '- Mix ALL THREE types: "single" (4 options, 1 index in correctIndexes), "multiple" (4 options, 2+ indexes in correctIndexes), and "written" (empty options [], empty correctIndexes [], concise modelAnswer string).',
      studentLang === 'arabic'
        ? '- STRICT LANGUAGE RULE: Write ALL retest questions, options, model answers, explanations, and subtopics in Modern Standard Arabic ONLY.'
        : '- STRICT LANGUAGE RULE: Write ALL retest questions, options, model answers, explanations, and subtopics strictly in simple English (CEFR B1) ONLY. Do NOT include any Arabic text.',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const { text: rawText } = await callGeminiWithRetryAndFallback({
        route: '/api/retest',
        contents: prompt,
        systemInstruction: buildLanguageSystemInstruction(studentLang),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            questions: {
              type: Type.ARRAY,
              description: 'Between 5 and 10 new mixed-type retest questions on the weak sub-topics.',
              items: QUESTION_SCHEMA,
            },
          },
          required: ['questions'],
        },
      });

      const parsed = JSON.parse(stripJsonCodeFences(rawText)) as { questions?: unknown };
      const questions = normalizeQuestions(parsed.questions, topic);
      if (questions.length < 5) {
        console.error('[Gemini][/api/retest] AI returned fewer than 5 retest questions:', questions.length);
        res.status(502).json({ ok: false, error: 'AI returned fewer than 5 retest questions.' });
        return;
      }

      res.json({
        ok: true,
        result: { questions },
      });
    } catch (err) {
      sendAiErrorResponse(res, '/api/retest', err);
    }
  });

  app.post('/api/grade-written', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const body = req.body as {
      course?: string;
      question?: string;
      modelAnswer?: string;
      studentAnswer?: string;
    };

    const course = typeof body.course === 'string' ? body.course.trim() : '';
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    const modelAnswer = typeof body.modelAnswer === 'string' ? body.modelAnswer.trim() : '';
    const studentAnswer = typeof body.studentAnswer === 'string' ? body.studentAnswer.trim() : '';

    if (!question || !studentAnswer) {
      res.status(400).json({ ok: false, error: 'Missing question or studentAnswer.' });
      return;
    }

    let notes: CourseNoteInput[] = [];
    if (course) {
      try {
        const ragResult = await retrieveCourseNotesFromServer({
          course,
          queryText: `${question} ${modelAnswer}`,
          limitCount: 6,
        });
        notes = ragResult.notes;
      } catch {
        notes = [];
      }
    }

    const studentLang: StudentLanguage = /[\u0600-\u06FF]/.test(studentAnswer)
      ? 'arabic'
      : /[A-Za-z]{3,}/.test(studentAnswer)
        ? 'english'
        : detectStudentLanguage(question);
    const formattedNotes = formatCourseNotesForPrompt(notes);

    const prompt = [
      'Course Notes:',
      formattedNotes || '(Grade strictly against the Model Answer)',
      '',
      `Question: ${question}`,
      `Model Answer: ${modelAnswer}`,
      `Student Written Answer: ${studentAnswer}`,
      '',
      'Instructions:',
      '- Grade the student written answer against the Model Answer and Course Notes.',
      '- Accept answers with the right meaning even if worded differently.',
      '- Return JSON with "correct" (boolean) and "feedback" (1-2 simple sentences explaining why it is right or what key idea is missing).',
      studentLang === 'arabic'
        ? '- STRICT LANGUAGE RULE: Write feedback in Modern Standard Arabic ONLY.'
        : '- STRICT LANGUAGE RULE: Write feedback strictly in simple English (CEFR B1) ONLY. Do NOT include any Arabic text.',
    ].join('\n');

    try {
      const { text: rawText } = await callGeminiWithRetryAndFallback({
        route: '/api/grade-written',
        contents: prompt,
        systemInstruction: buildLanguageSystemInstruction(studentLang),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            correct: {
              type: Type.BOOLEAN,
              description: 'True if the student answer expresses the correct core concept.',
            },
            feedback: {
              type: Type.STRING,
              description: '1-2 simple sentences of constructive feedback grounded in the notes.',
            },
          },
          required: ['correct', 'feedback'],
        },
      });

      const parsed = JSON.parse(stripJsonCodeFences(rawText)) as {
        correct?: boolean;
        feedback?: string;
      };
      res.json({
        ok: true,
        result: {
          correct: Boolean(parsed.correct),
          feedback: String(parsed.feedback || ''),
        },
      });
    } catch (err) {
      sendAiErrorResponse(res, '/api/grade-written', err);
    }
  });

  app.post('/api/tutor-brief', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const body = req.body as {
      studentText?: string;
      attachmentContext?: string;
      topic?: string;
      weakSubtopics?: string[];
      wrongAnswers?: Array<{
        stage?: string;
        question?: string;
        subtopic?: string;
        studentAnswer?: string;
        correctAnswer?: string;
      }>;
    };

    const studentText = typeof body.studentText === 'string' ? body.studentText.trim() : '';
    const attachmentContext =
      typeof body.attachmentContext === 'string' ? body.attachmentContext.trim() : '';
    const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
    const weakSubtopics = Array.isArray(body.weakSubtopics) ? body.weakSubtopics.filter(Boolean) : [];
    const wrongAnswers = Array.isArray(body.wrongAnswers) ? body.wrongAnswers : [];

    if (!studentText || !topic) {
      res.status(400).json({ ok: false, error: 'Missing studentText or topic.' });
      return;
    }

    const tutorSystemInstruction =
      "You are preparing a tutor for a 30-minute ASC session. Using ONLY the data given, write a short brief for the tutor: the student's problem in their words (including key points from their attached files/notes if any), the topic, the weak sub-topics, the questions they got wrong (with their wrong answers), and a suggested 30-minute plan in 3 steps. Plain text, under 200 words, English. Put each section on its own line with a blank line before the 3-step plan, and put each of the 3 steps on its own numbered line (1. ..., 2. ..., 3. ...).";

    const formattedWrongAnswers =
      wrongAnswers.length > 0
        ? wrongAnswers
            .map(
              (w, idx) =>
                `${idx + 1}. [${w.stage || 'quiz'}] (${w.subtopic || topic}) Q: ${w.question || ''} | Student answered: "${w.studentAnswer || ''}" | Correct answer: "${w.correctAnswer || ''}"`
            )
            .join('\n')
        : 'None recorded.';

    const prompt = [
      `Student Problem (in their words): ${studentText}`,
      attachmentContext ? `Student Notes & Attached Files:\n${attachmentContext.slice(0, 6000)}` : '',
      `Topic: ${topic}`,
      `Weak Sub-topics: ${weakSubtopics.length > 0 ? weakSubtopics.join(', ') : topic}`,
      '',
      'Questions Got Wrong (Diagnostic and Retest):',
      formattedWrongAnswers,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const { text: brief } = await callGeminiWithRetryAndFallback({
        route: '/api/tutor-brief',
        contents: prompt,
        systemInstruction: tutorSystemInstruction,
      });

      res.json({ ok: true, brief });
    } catch (err) {
      sendAiErrorResponse(res, '/api/tutor-brief', err);
    }
  });

  app.post('/api/parse-transcript', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const body = req.body as {
      fileBase64?: string;
      mimeType?: string;
      fileName?: string;
      catalogCourses?: string[];
      minGpa?: number;
      requireFirstSemesterCompleted?: boolean;
    };

    const fileBase64 = typeof body.fileBase64 === 'string' ? body.fileBase64.trim() : '';
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';
    const catalogCourses = Array.isArray(body.catalogCourses)
      ? body.catalogCourses.map((c) => String(c).trim()).filter(Boolean)
      : [];
    const minGpa =
      typeof body.minGpa === 'number' && Number.isFinite(body.minGpa) ? body.minGpa : 3.0;
    const requireFirstSemesterCompleted =
      typeof body.requireFirstSemesterCompleted === 'boolean'
        ? body.requireFirstSemesterCompleted
        : true;

    const allowedMimes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!fileBase64 || !allowedMimes.includes(mimeType)) {
      res.status(400).json({
        ok: false,
        error: 'Please upload a valid PDF, PNG, JPEG, or WebP transcript file.',
      });
      return;
    }

    const normalizedMime = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;
    const cleanBase64 = fileBase64.replace(/^data:[^;]+;base64,/, '');

    const transcriptInstruction = [
      'You are an academic records verification assistant for the HCT Academic Success Center.',
      'Carefully read the attached academic transcript (PDF or image) and extract factual academic metrics.',
      'NEVER invent grades or courses that are not present in the document.',
      'For hasCompletedFirstSemester: return true ONLY if the transcript shows at least 1 completed semester/term with final posted letter/numeric grades and earned credits (> 0). If all courses are In Progress (IP), withdrawn, or completedCredits is 0, return false.',
      'For each course, include code (e.g. CYB3513), title, grade, credits (number), and passed (true if completed with a passing grade like A, A-, B+, B, B-, C+, C, or P; false for D, F, W, IP, I).',
    ].join(' ');

    const promptText = [
      'Extract the student transcript data into JSON.',
      catalogCourses.length > 0
        ? `Platform course catalog for reference: ${catalogCourses.join(', ')}`
        : '',
      'Return exact cumulative GPA, count of completed semesters, total completed credits, hasCompletedFirstSemester, extractedCourses array, and a short 1-2 sentence summary.',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const { text: rawText } = await callGeminiWithRetryAndFallback({
        route: '/api/parse-transcript',
        contents: {
          parts: [
            { inlineData: { mimeType: normalizedMime, data: cleanBase64 } },
            { text: promptText },
          ],
        },
        systemInstruction: transcriptInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            cumulativeGpa: {
              type: Type.NUMBER,
              description: 'Cumulative GPA on a 4.0 scale (0 if not found).',
            },
            gpaFound: {
              type: Type.BOOLEAN,
              description: 'True if a cumulative GPA value was clearly readable on the transcript.',
            },
            completedSemesters: {
              type: Type.INTEGER,
              description: 'Number of completed semesters/terms with final posted grades.',
            },
            completedCredits: {
              type: Type.NUMBER,
              description: 'Total completed/earned credit hours.',
            },
            hasCompletedFirstSemester: {
              type: Type.BOOLEAN,
              description: 'True if the student has completed at least one full semester with final grades.',
            },
            extractedCourses: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  code: { type: Type.STRING },
                  title: { type: Type.STRING },
                  grade: { type: Type.STRING },
                  credits: { type: Type.NUMBER },
                  passed: { type: Type.BOOLEAN },
                },
                required: ['code', 'title', 'grade', 'passed'],
              },
            },
            summary: {
              type: Type.STRING,
              description: 'Short 1-2 sentence verification summary.',
            },
          },
          required: [
            'cumulativeGpa',
            'gpaFound',
            'completedSemesters',
            'completedCredits',
            'hasCompletedFirstSemester',
            'extractedCourses',
            'summary',
          ],
        },
      });

      const parsed = JSON.parse(stripJsonCodeFences(rawText)) as {
        cumulativeGpa?: number;
        gpaFound?: boolean;
        completedSemesters?: number;
        completedCredits?: number;
        hasCompletedFirstSemester?: boolean;
        extractedCourses?: Array<{
          code?: string;
          title?: string;
          grade?: string;
          credits?: number;
          passed?: boolean;
        }>;
        summary?: string;
      };

      const cumulativeGpa = Math.max(0, Math.min(4.5, Number(parsed.cumulativeGpa) || 0));
      const gpaFound = Boolean(parsed.gpaFound) && cumulativeGpa > 0;
      const completedSemesters = Math.max(0, Math.floor(Number(parsed.completedSemesters) || 0));
      const completedCredits = Math.max(0, Number(parsed.completedCredits) || 0);
      const hasCompletedFirstSemester =
        Boolean(parsed.hasCompletedFirstSemester) && completedSemesters >= 1 && completedCredits > 0;

      const normalizeCourseCode = (code: string) =>
        code.toUpperCase().replace(/[^A-Z0-9]/g, '');

      const isQualifyingTutorGrade = (gradeRaw: string, passedFlag: boolean): boolean => {
        const g = gradeRaw.toUpperCase().trim();
        if (!g) return passedFlag;
        if (['IP', 'IN PROGRESS', 'W', 'WP', 'WF', 'F', 'FA', 'I', 'NP', 'FAIL', 'D', 'D+', 'D-'].includes(g)) {
          return false;
        }
        if (/^(A\+|A|A-|B\+|B|B-|C\+|C|P|PASS)$/.test(g)) {
          return true;
        }
        const numeric = Number(g.replace('%', ''));
        if (!Number.isNaN(numeric) && numeric > 0) {
          return numeric >= 70;
        }
        return passedFlag;
      };

      const extractedCourses = (Array.isArray(parsed.extractedCourses) ? parsed.extractedCourses : []).map(
        (c) => {
          const code = String(c.code || '').trim().toUpperCase();
          const grade = String(c.grade || '').trim();
          const passed = isQualifyingTutorGrade(grade, Boolean(c.passed));
          return {
            code,
            title: String(c.title || '').trim(),
            grade,
            credits: typeof c.credits === 'number' && Number.isFinite(c.credits) ? c.credits : 0,
            passed,
          };
        }
      );

      const matchedCourses = catalogCourses.filter((catalogCode) => {
        const normCatalog = normalizeCourseCode(catalogCode);
        return extractedCourses.some(
          (ec) => ec.passed && normalizeCourseCode(ec.code) === normCatalog
        );
      });

      let eligible = true;
      let autoRejected = false;
      let screeningReason =
        'Passed automated pre-screening: first semester completed and GPA meets the minimum threshold. Ready for ASC Admin review.';

      if (requireFirstSemesterCompleted && !hasCompletedFirstSemester) {
        eligible = false;
        autoRejected = true;
        screeningReason =
          'Automatically rejected: Students must complete at least their first semester with posted grades and earned credits before applying to become a peer tutor.';
      } else if (!gpaFound) {
        eligible = false;
        autoRejected = true;
        screeningReason =
          'Automatically rejected: Could not verify a cumulative GPA on the uploaded transcript. Please upload an official transcript showing your cumulative GPA.';
      } else if (cumulativeGpa < minGpa) {
        eligible = false;
        autoRejected = true;
        screeningReason = `Automatically rejected: Cumulative GPA (${cumulativeGpa.toFixed(
          2
        )}) is below the required minimum GPA of ${minGpa.toFixed(2)}.`;
      }

      res.json({
        ok: true,
        result: {
          cumulativeGpa: Number(cumulativeGpa.toFixed(2)),
          gpaFound,
          completedSemesters,
          completedCredits,
          hasCompletedFirstSemester,
          extractedCourses,
          matchedCourses,
          eligible,
          autoRejected,
          screeningReason,
          summary: String(parsed.summary || '').trim(),
        },
      });
    } catch (err) {
      sendAiErrorResponse(res, '/api/parse-transcript', err);
    }
  });

  app.post('/api/tutor-applications/notify', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const body = req.body as {
      applicantEmail?: string;
      applicantName?: string;
      applicantType?: 'student' | 'faculty';
      status?: 'approved' | 'rejected';
      approvedCourses?: string[];
      reason?: string;
      autoScreened?: boolean;
    };

    const applicantEmail = typeof body.applicantEmail === 'string' ? body.applicantEmail.trim() : '';
    const applicantName = typeof body.applicantName === 'string' ? body.applicantName.trim() : 'Applicant';
    const status = body.status === 'approved' ? 'approved' : 'rejected';
    const approvedCourses = Array.isArray(body.approvedCourses) ? body.approvedCourses : [];
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

    if (!applicantEmail) {
      res.status(400).json({ ok: false, error: 'Missing applicantEmail.' });
      return;
    }

    const subject =
      status === 'approved'
        ? 'Sanad ASC Tutor Application Approved'
        : 'Sanad ASC Tutor Application Status Update';

    const messageBody =
      status === 'approved'
        ? `Dear ${applicantName},\n\nCongratulations! Your application to become an HCT Academic Success Center Tutor on Sanad has been approved.\nApproved courses: ${
            approvedCourses.length > 0 ? approvedCourses.join(', ') : 'Assigned by ASC'
          }.\n${reason ? `Coordinator notes: ${reason}\n` : ''}\nYou can now sign in to Sanad to manage your courses, add availability slots, and support students.`
        : `Dear ${applicantName},\n\nThank you for applying to become a tutor with the HCT Academic Success Center on Sanad.\nYour application status has been updated to Rejected.\n${
            reason ? `Reason: ${reason}\n` : ''
          }\nPlease reach out to the ASC Coordinator if you have questions or wish to reapply in a future semester.`;

    let channel = 'portal-audit';
    let dispatched = false;

    const webhookUrl = process.env.EMAIL_WEBHOOK_URL?.trim();
    if (webhookUrl) {
      try {
        const hookRes = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: applicantEmail, subject, text: messageBody }),
          signal: AbortSignal.timeout(8_000),
        });
        if (hookRes.ok) {
          channel = 'email-webhook';
          dispatched = true;
        }
      } catch (err) {
        console.warn('[Notify] EMAIL_WEBHOOK_URL failed (skipped):', err);
      }
    }

    res.json({
      ok: true,
      sent: dispatched,
      channel,
      subject,
      detail: dispatched
        ? `Email notification sent via ${channel}`
        : 'Decision saved in Sanad portal',
    });
  });

  app.post('/api/materials/ingest', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const body = req.body as {
      fileBase64?: string;
      fileName?: string;
      courseCode?: string;
      courseName?: string;
    };

    const rawBase64 = typeof body.fileBase64 === 'string' ? body.fileBase64.trim() : '';
    const cleanBase64 = rawBase64.replace(/^data:[^;]+;base64,/, '');
    const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
    const courseCode = typeof body.courseCode === 'string' ? body.courseCode.trim() : '';

    if (!cleanBase64 || !fileName || !courseCode) {
      res.status(400).json({ ok: false, error: 'Missing fileBase64, fileName, or courseCode.' });
      return;
    }

    if (!fileName.toLowerCase().endsWith('.pdf')) {
      res.status(400).json({ ok: false, error: 'Only PDF (.pdf) course files are supported.' });
      return;
    }

    const pdfBuffer = Buffer.from(cleanBase64, 'base64');
    if (pdfBuffer.length === 0) {
      res.status(400).json({ ok: false, error: 'Uploaded PDF file is empty.' });
      return;
    }
    if (pdfBuffer.length > MAX_PDF_BYTES) {
      res.status(400).json({ ok: false, error: 'PDF file exceeds the 25 MB limit.' });
      return;
    }
    if (pdfBuffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      res.status(400).json({ ok: false, error: 'Uploaded file does not have a valid PDF header.' });
      return;
    }

    try {
      let extractedText = '';
      let pageCount = 0;
      let extractionMethod: 'pdfjs' | 'gemini-multimodal' = 'pdfjs';

      try {
        const parsed = await extractPdfTextWithPdfJs(pdfBuffer);
        extractedText = parsed.text;
        pageCount = parsed.pageCount;
      } catch (pdfErr) {
        console.warn(`[MaterialsIngest] pdfjs-dist extraction fell back for ${fileName}:`, pdfErr);
      }

      const alphanumericCount = extractedText.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '').length;
      if (alphanumericCount < 50) {
        extractionMethod = 'gemini-multimodal';
        extractedText = await extractPdfTextWithGeminiMultimodal(cleanBase64, fileName, true);
      }

      const rawChunks = splitTextIntoOverlappingChunks(extractedText, 1800, 150);
      if (rawChunks.length === 0) {
        res.status(422).json({
          ok: false,
          error: 'Could not read any text from this PDF file.',
        });
        return;
      }

      const vectors = await embedTextsWithRetry(rawChunks, { priority: 'batch' });
      const chunks = rawChunks.map((text, idx) => ({
        chunkIndex: idx,
        text,
        embedding: vectors[idx],
        embeddingModel: EMBEDDING_MODEL,
        embeddingDim: EMBEDDING_DIM,
      }));

      console.log(
        `[MaterialsIngest] file=${fileName} course=${courseCode} method=${extractionMethod} pages=${pageCount} chunks=${chunks.length} model=${EMBEDDING_MODEL}`
      );

      res.json({
        ok: true,
        extractionMethod,
        pageCount,
        totalCharacters: extractedText.length,
        embeddingModel: EMBEDDING_MODEL,
        embeddingDim: EMBEDDING_DIM,
        chunks,
      });
    } catch (err) {
      sendAiErrorResponse(res, '/api/materials/ingest', err);
    }
  });

  app.post('/api/materials/reembed-chunks', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    try {
      const db = await getServerFirestore(false);
      const userSnap = await getDoc(doc(db, 'users', uid));
      const userData = userSnap.exists() ? (userSnap.data() as Record<string, unknown>) : null;
      if (!userData || userData.role !== 'admin' || userData.active === false) {
        res.status(403).json({ ok: false, error: 'Only admins can refresh course AI notes.' });
        return;
      }
    } catch (err) {
      console.error('[MaterialsReembed] Admin check failed:', err);
      res.status(500).json({ ok: false, error: 'Could not verify account permissions.' });
      return;
    }

    const body = req.body as { texts?: unknown };
    const texts = Array.isArray(body.texts)
      ? body.texts.map((t) => String(t ?? '').trim()).filter(Boolean)
      : [];
    if (texts.length === 0) {
      res.status(400).json({ ok: false, error: 'No note sections provided.' });
      return;
    }

    try {
      const embeddings = await embedTextsWithRetry(texts, { priority: 'batch' });
      res.json({
        ok: true,
        embeddings,
        embeddingModel: EMBEDDING_MODEL,
        embeddingDim: EMBEDDING_DIM,
      });
    } catch (err) {
      sendAiErrorResponse(res, '/api/materials/reembed-chunks', err);
    }
  });

  app.post('/api/materials/invalidate-cache', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const body = req.body as { courseCode?: unknown };
    const courseCode = typeof body.courseCode === 'string' ? body.courseCode.trim() : '';
    invalidateCourseRagCache(courseCode || undefined);
    res.json({ ok: true });
  });

  app.post('/api/materials/embed-query', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const body = req.body as { text?: string };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ ok: false, error: 'Missing query text.' });
      return;
    }

    try {
      const vectors = await embedTextsWithRetry([text]);
      res.json({
        ok: true,
        embedding: vectors[0] || [],
        embeddingModel: EMBEDDING_MODEL,
        embeddingDim: EMBEDDING_DIM,
      });
    } catch (err) {
      sendAiErrorResponse(res, '/api/materials/embed-query', err);
    }
  });

  const TUTOR_NOTE_PART_CHARS = 700_000;

  app.post('/api/tutor-notes/attachments', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    let db: Firestore;
    try {
      db = await getServerFirestore(false);
      let userSnap = await getDoc(doc(db, 'users', uid));
      if (!userSnap.exists()) {
        db = await getServerFirestore(true);
        userSnap = await getDoc(doc(db, 'users', uid));
      }
      const userData = userSnap.exists() ? (userSnap.data() as Record<string, unknown>) : null;
      const role = typeof userData?.role === 'string' ? userData.role : '';
      const active = userData?.active === true;
      const isAllowed = (role === 'tutor' && active) || (role === 'admin' && userData?.active !== false);
      if (!isAllowed) {
        res.status(403).json({ ok: false, error: 'Only active tutors can upload note attachments.' });
        return;
      }
    } catch (err) {
      console.error('[TutorNoteAttachments] Auth check failed:', err);
      res.status(500).json({ ok: false, error: 'Could not verify tutor account.' });
      return;
    }

    const body = req.body as {
      files?: Array<{
        fileName?: string;
        mimeType?: string;
        base64Data?: string;
      }>;
    };
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) {
      res.status(400).json({ ok: false, error: 'No attachment files provided.' });
      return;
    }
    if (files.length > MAX_ATTACHMENT_FILES) {
      res.status(400).json({
        ok: false,
        error: `You can attach up to ${MAX_ATTACHMENT_FILES} files per post.`,
      });
      return;
    }

    try {
      const savedAttachments: Array<{
        id: string;
        fileName: string;
        mimeType: 'image/png' | 'image/jpeg' | 'application/pdf';
        size: number;
        partCount: number;
      }> = [];

      for (const item of files) {
        const fileName = typeof item.fileName === 'string' ? item.fileName.trim() : 'attachment';
        const rawMime = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
        const normalizedMime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;

        if (
          normalizedMime !== 'image/png' &&
          normalizedMime !== 'image/jpeg' &&
          normalizedMime !== 'application/pdf'
        ) {
          res.status(400).json({
            ok: false,
            error: `Unsupported file type for "${fileName}". Only PNG, JPG/JPEG images, and PDF files are allowed.`,
          });
          return;
        }

        const rawBase64 = typeof item.base64Data === 'string' ? item.base64Data.trim() : '';
        const cleanBase64 = rawBase64.replace(/^data:[^;]+;base64,/, '');
        if (!cleanBase64) {
          res.status(400).json({ ok: false, error: `File "${fileName}" is empty.` });
          return;
        }

        const buf = Buffer.from(cleanBase64, 'base64');
        if (buf.length === 0) {
          res.status(400).json({ ok: false, error: `File "${fileName}" is empty.` });
          return;
        }
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          res.status(400).json({
            ok: false,
            error: `File "${fileName}" exceeds the 10 MB limit.`,
          });
          return;
        }
        if (normalizedMime === 'application/pdf' && buf.subarray(0, 5).toString('ascii') !== '%PDF-') {
          res.status(400).json({
            ok: false,
            error: `File "${fileName}" is not a valid PDF document.`,
          });
          return;
        }

        const attachmentId = makeServerId('att');
        const canonicalBase64 = buf.toString('base64');
        const totalParts = Math.max(1, Math.ceil(canonicalBase64.length / TUTOR_NOTE_PART_CHARS));
        const batch = writeBatch(db);
        for (let i = 0; i < totalParts; i++) {
          const slice = canonicalBase64.slice(
            i * TUTOR_NOTE_PART_CHARS,
            (i + 1) * TUTOR_NOTE_PART_CHARS
          );
          const partId = `${attachmentId}_p${i}`;
          batch.set(doc(db, 'tutorNoteFiles', partId), {
            attachmentId,
            tutorId: uid,
            partIndex: i,
            totalParts,
            data: slice,
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();

        savedAttachments.push({
          id: attachmentId,
          fileName: fileName.slice(0, 255),
          mimeType: normalizedMime,
          size: buf.length,
          partCount: totalParts,
        });
      }

      res.json({ ok: true, attachments: savedAttachments });
    } catch (err) {
      console.error('[TutorNoteAttachments] Upload failed:', err);
      res.status(500).json({ ok: false, error: 'Could not save attachments. Please try again.' });
    }
  });

  app.post('/api/tutor-notes/cleanup-attachments', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const body = req.body as { attachmentIds?: unknown };
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    if (attachmentIds.length === 0) {
      res.json({ ok: true });
      return;
    }

    try {
      const db = await getServerFirestore(false);
      const userSnap = await getDoc(doc(db, 'users', uid));
      const userData = userSnap.exists() ? (userSnap.data() as Record<string, unknown>) : null;
      const isAdminCaller = userData?.role === 'admin' && userData?.active !== false;
      const isTutorCaller = userData?.role === 'tutor' && userData?.active === true;
      if (!isAdminCaller && !isTutorCaller) {
        res.status(403).json({ ok: false, error: 'Permission denied.' });
        return;
      }

      for (const attId of attachmentIds) {
        const snap = await getDocs(
          query(collection(db, 'tutorNoteFiles'), where('attachmentId', '==', attId))
        );
        for (const docSnap of snap.docs) {
          const data = docSnap.data() as Record<string, unknown>;
          if (isAdminCaller || data.tutorId === uid) {
            await deleteDoc(docSnap.ref);
          }
        }
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[TutorNoteAttachments] Cleanup failed:', err);
      res.status(500).json({ ok: false, error: 'Could not clean up attachments.' });
    }
  });

  app.get('/api/tutor-notes/:noteId/attachments/:attachmentId', async (req, res) => {
    const authHeader =
      req.headers.authorization ||
      (typeof req.query.token === 'string' && req.query.token.trim()
        ? `Bearer ${req.query.token.trim()}`
        : undefined);
    const uid = await verifyFirebaseBearerToken(authHeader);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const noteId = String(req.params.noteId || '').trim();
    const attachmentId = String(req.params.attachmentId || '').trim();
    const download = String(req.query.download || '') === '1';

    if (!noteId || !attachmentId) {
      res.status(400).json({ ok: false, error: 'Missing note or attachment id.' });
      return;
    }

    try {
      const db = await getServerFirestore(false);
      const [noteSnap, userSnap] = await Promise.all([
        getDoc(doc(db, 'tutorNotes', noteId)),
        getDoc(doc(db, 'users', uid)),
      ]);

      if (!noteSnap.exists()) {
        res.status(404).json({ ok: false, error: 'Tutor note not found.' });
        return;
      }
      if (!userSnap.exists()) {
        res.status(403).json({ ok: false, error: 'Account access denied.' });
        return;
      }

      const noteData = noteSnap.data() as Record<string, unknown>;
      const userData = userSnap.data() as Record<string, unknown>;
      const role = typeof userData.role === 'string' ? userData.role : '';
      const active = userData.active === true;

      let allowed = false;
      if (role === 'admin' && userData.active !== false) {
        allowed = true;
      } else if (role === 'tutor' && active && noteData.tutorId === uid) {
        allowed = true;
      } else if (role === 'student' && active) {
        if (noteData.audience === 'student' && noteData.studentId === uid) {
          allowed = true;
        } else if (noteData.audience === 'course') {
          const noteCourse = normalizeCourseCodeServer(String(noteData.courseCode || ''));
          const enrolled = String(userData.subjects || '')
            .split(',')
            .map((c) => normalizeCourseCodeServer(c))
            .filter(Boolean);
          if (noteCourse && enrolled.includes(noteCourse)) {
            allowed = true;
          }
        }
      }

      if (!allowed) {
        res.status(403).json({ ok: false, error: 'You do not have permission to view this attachment.' });
        return;
      }

      const attachments = Array.isArray(noteData.attachments)
        ? (noteData.attachments as Array<Record<string, unknown>>)
        : [];
      const targetMeta = attachments.find((a) => String(a?.id || '') === attachmentId);
      if (!targetMeta) {
        res.status(404).json({ ok: false, error: 'Attachment not found on this note.' });
        return;
      }

      const partsSnap = await getDocs(
        query(collection(db, 'tutorNoteFiles'), where('attachmentId', '==', attachmentId))
      );
      if (partsSnap.empty) {
        res.status(404).json({ ok: false, error: 'Attachment file content not found.' });
        return;
      }

      const sortedParts = partsSnap.docs
        .map((d) => d.data() as Record<string, unknown>)
        .sort((a, b) => Number(a.partIndex || 0) - Number(b.partIndex || 0));

      const fullBase64 = sortedParts.map((p) => String(p.data || '')).join('');
      const fileBuffer = Buffer.from(fullBase64, 'base64');
      const mimeType =
        typeof targetMeta.mimeType === 'string' && targetMeta.mimeType.trim()
          ? targetMeta.mimeType.trim()
          : 'application/octet-stream';
      const safeName = String(targetMeta.fileName || 'attachment')
        .replace(/["\r\n]/g, '')
        .trim() || 'attachment';

      res.setHeader('Content-Type', mimeType);
      res.setHeader(
        'Content-Disposition',
        `${download ? 'attachment' : 'inline'}; filename="${safeName}"`
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(fileBuffer);
    } catch (err) {
      console.error('[TutorNoteAttachments] Stream failed:', err);
      res.status(500).json({ ok: false, error: 'Could not load attachment.' });
    }
  });

  app.get('/api/crypto/status', (_req, res) => {
    const key = getEncryptionKeyBuffer();
    res.json({
      ok: true,
      configured: key !== null,
    });
  });

  app.post('/api/crypto/encrypt', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const key = getEncryptionKeyBuffer();
    if (!key) {
      res.status(503).json({
        ok: false,
        error: 'Portal security setup is incomplete. Please contact an administrator.',
      });
      return;
    }

    const body = req.body as { fields?: Record<string, unknown> };
    const fields = body?.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      res.status(400).json({ ok: false, error: 'Invalid request data.' });
      return;
    }

    try {
      const encrypted: Record<string, EncryptedBlob> = {};
      for (const [fieldKey, val] of Object.entries(fields)) {
        const text = typeof val === 'string' ? val : JSON.stringify(val ?? '');
        encrypted[fieldKey] = encryptAes256Gcm(text, key);
      }
      res.json({ ok: true, encrypted });
    } catch {
      res.status(500).json({ ok: false, error: 'Could not save private information. Please try again.' });
    }
  });

  app.post('/api/crypto/decrypt', async (req, res) => {
    const uid = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    const key = getEncryptionKeyBuffer();
    if (!key) {
      res.status(503).json({
        ok: false,
        error: 'Portal security setup is incomplete. Please contact an administrator.',
      });
      return;
    }

    const body = req.body as { fields?: Record<string, unknown> };
    const fields = body?.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      res.status(400).json({ ok: false, error: 'Invalid request data.' });
      return;
    }

    try {
      const decrypted: Record<string, string> = {};
      for (const [fieldKey, val] of Object.entries(fields)) {
        if (!val || typeof val !== 'object') {
          decrypted[fieldKey] = '';
          continue;
        }
        const blob = val as Partial<EncryptedBlob>;
        if (
          typeof blob.iv !== 'string' ||
          typeof blob.tag !== 'string' ||
          typeof blob.ciphertext !== 'string'
        ) {
          res.status(400).json({ ok: false, error: `Could not read saved item for ${fieldKey}.` });
          return;
        }
        decrypted[fieldKey] = decryptAes256Gcm(
          { iv: blob.iv, tag: blob.tag, ciphertext: blob.ciphertext },
          key
        );
      }
      res.json({ ok: true, decrypted });
    } catch {
      res.status(400).json({ ok: false, error: 'Could not load saved information. Please contact an administrator.' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sanad server listening on http://localhost:${PORT}`);
  });
}

createServer().catch((err) => {
  console.error('Failed to start Sanad server:', err);
  process.exit(1);
});
