/* ==========================================================================
   SHARED STUDY CONFIG
   Single source of truth for study modes, JSON schemas, prompt construction,
   output-token budgets, and response validation. Used by the browser BYOK
   path (app.js) and the Cloudflare guest generation function
   (functions/api/generate-study-deck.js).

   The server MUST build its schema/system-instruction from this module based
   only on a validated `mode` string — never from client-supplied schemas or
   instructions.
   ========================================================================== */

export const STUDY_MODES = ['summary', 'eli5', 'notes', 'flashcards'];

export const MAX_SUBJECT_CONTEXT_LENGTH = 200;
export const MAX_TEXT_INPUT_LENGTH = 20000;
export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_GUEST_IMAGE_BYTES = 4 * 1024 * 1024; // ~4MB after client compression

export function isValidStudyMode(mode) {
  return typeof mode === 'string' && STUDY_MODES.includes(mode);
}

// Trims and hard-caps subject context so it can never be used to smuggle
// oversized or malicious content into the prompt.
export function sanitizeSubjectContext(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value.slice(0, MAX_SUBJECT_CONTEXT_LENGTH);
}

export function getModeLabel(mode) {
  if (mode === 'summary') return 'Summary Bullets';
  if (mode === 'eli5') return 'ELI5 Simplification';
  if (mode === 'notes') return 'Detailed Outline';
  if (mode === 'flashcards') return 'Q&A Flashcards';
  return 'Study Deck';
}

/* ==========================================================================
   OUTPUT-TOKEN BUDGETS
   Mode-aware safety ceilings so neither generation path relies on an
   unspecified model default. These are starting safety limits, not claims
   about model capacity — they exist to make MAX_TOKENS truncation rare, not
   to guarantee every detail is included for very large sources.
   ========================================================================== */

export const OUTPUT_TOKEN_BUDGETS = Object.freeze({
  summary: 4096,
  eli5: 4096,
  flashcards: 6144,
  notes: 12288
});

export function getOutputTokenBudget(mode) {
  return OUTPUT_TOKEN_BUDGETS[mode] || OUTPUT_TOKEN_BUDGETS.summary;
}

// Conservative bounds for the optional GEMINI_GUEST_MAX_OUTPUT_TOKENS server
// env override. Never trust an out-of-range or non-integer env value.
export const GUEST_MAX_OUTPUT_TOKENS_MIN = 256;
export const GUEST_MAX_OUTPUT_TOKENS_MAX = 16384;

// Resolves the actual output-token budget for a guest request: a validated
// server env override if present and in range, otherwise the mode-aware
// default. The browser can never influence this value — it is never read
// from the request body.
export function resolveGuestOutputTokenBudget(mode, envOverrideRaw) {
  const modeDefault = getOutputTokenBudget(mode);
  if (envOverrideRaw === undefined || envOverrideRaw === null || envOverrideRaw === '') {
    return modeDefault;
  }
  const parsed = Number(envOverrideRaw);
  const isSafeInteger = Number.isInteger(parsed) &&
    parsed >= GUEST_MAX_OUTPUT_TOKENS_MIN &&
    parsed <= GUEST_MAX_OUTPUT_TOKENS_MAX;
  return isSafeInteger ? parsed : modeDefault;
}

/* ==========================================================================
   COMPLETION NORMALIZATION
   The Gemini REST API (Guest path) and the @google/genai browser SDK (BYOK
   path) both surface `finishReason` on the response candidate using the same
   enum strings (STOP, MAX_TOKENS, SAFETY, PROHIBITED_CONTENT, ...), but each
   path reaches that candidate through a different response shape. Callers
   are responsible for extracting the raw finishReason from their own
   response shape; this module only normalizes the string itself so both
   paths share one set of internal categories.
   ========================================================================== */

export const COMPLETION_CATEGORIES = Object.freeze({
  COMPLETE: 'complete',
  MAX_TOKENS: 'max_tokens',
  SAFETY_BLOCK: 'safety_block',
  EMPTY_RESPONSE: 'empty_response',
  MALFORMED_RESPONSE: 'malformed_response',
  MODEL_ERROR: 'model_error',
  UNKNOWN: 'unknown'
});

export function normalizeFinishReason(finishReason) {
  if (!finishReason) return COMPLETION_CATEGORIES.UNKNOWN;
  const reason = String(finishReason).toUpperCase();
  if (reason === 'STOP') return COMPLETION_CATEGORIES.COMPLETE;
  if (reason === 'MAX_TOKENS') return COMPLETION_CATEGORIES.MAX_TOKENS;
  if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT' || reason === 'BLOCKLIST' || reason === 'SPII') {
    return COMPLETION_CATEGORIES.SAFETY_BLOCK;
  }
  if (reason === 'RECITATION' || reason === 'LANGUAGE' || reason === 'OTHER' || reason === 'MALFORMED_FUNCTION_CALL') {
    return COMPLETION_CATEGORIES.MODEL_ERROR;
  }
  return COMPLETION_CATEGORIES.UNKNOWN;
}

/* ==========================================================================
   TRUNCATED JSON DETECTION
   A best-effort heuristic used only to decide whether a compact retry is
   worthwhile — never treated as a reliable parser. Well-formed JSON always
   ends in a closing brace/bracket/quote with balanced nesting; a response
   cut off mid-stream by a token limit almost never does.
   ========================================================================== */

function isBalancedJsonPunctuation(text) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\' && inString) { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
  }
  return depth === 0 && !inString;
}

export function looksLikeTruncatedJson(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const lastChar = trimmed[trimmed.length - 1];
  if (lastChar === '}' || lastChar === ']') {
    return !isBalancedJsonPunctuation(trimmed);
  }
  return true; // Ends mid-string/mid-token/mid-number — classic truncation signature.
}

/* ==========================================================================
   DECK STRUCTURE VALIDATION
   Confirms a parsed response matches the shape the renderer expects for its
   mode before it is ever saved to history or rendered. Deliberately a small
   hand-written validator rather than a schema library — the shapes are
   simple and fixed per mode.
   ========================================================================== */

function isString(v) { return typeof v === 'string'; }

export function validateDeckStructure(mode, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, reason: 'Deck data is not an object.' };
  }

  if (mode === 'summary') {
    if (!isString(data.title)) return { valid: false, reason: 'Missing title.' };
    if (!isString(data.subtitle)) return { valid: false, reason: 'Missing subtitle.' };
    if (!Array.isArray(data.bullets) || data.bullets.length === 0) {
      return { valid: false, reason: 'Missing bullets.' };
    }
    for (const b of data.bullets) {
      if (!b || !isString(b.label) || !isString(b.content)) {
        return { valid: false, reason: 'Malformed bullet entry.' };
      }
    }
    if (!isString(data.takeaway)) return { valid: false, reason: 'Missing takeaway.' };
    return { valid: true };
  }

  if (mode === 'eli5') {
    if (!isString(data.title)) return { valid: false, reason: 'Missing title.' };
    if (!isString(data.subtitle)) return { valid: false, reason: 'Missing subtitle.' };
    if (!isString(data.analogyTitle)) return { valid: false, reason: 'Missing analogyTitle.' };
    if (!isString(data.analogy)) return { valid: false, reason: 'Missing analogy.' };
    if (!isString(data.simpleExplanation)) return { valid: false, reason: 'Missing simpleExplanation.' };
    if (!isString(data.funFact)) return { valid: false, reason: 'Missing funFact.' };
    return { valid: true };
  }

  if (mode === 'notes') {
    if (!isString(data.title)) return { valid: false, reason: 'Missing title.' };
    if (!isString(data.subtitle)) return { valid: false, reason: 'Missing subtitle.' };
    if (!Array.isArray(data.sections) || data.sections.length === 0) {
      return { valid: false, reason: 'Missing sections.' };
    }
    for (const sec of data.sections) {
      if (!sec || !isString(sec.header) || !Array.isArray(sec.subsections)) {
        return { valid: false, reason: 'Malformed section entry.' };
      }
      for (const sub of sec.subsections) {
        if (!sub || !isString(sub.subHeader) || !Array.isArray(sub.bullets)) {
          return { valid: false, reason: 'Malformed subsection entry.' };
        }
        if (!sub.bullets.every(isString)) {
          return { valid: false, reason: 'Subsection bullets must be strings.' };
        }
      }
    }
    return { valid: true };
  }

  if (mode === 'flashcards') {
    if (!isString(data.title)) return { valid: false, reason: 'Missing title.' };
    if (!isString(data.subtitle)) return { valid: false, reason: 'Missing subtitle.' };
    if (!Array.isArray(data.cards) || data.cards.length === 0) {
      return { valid: false, reason: 'Missing cards.' };
    }
    for (const c of data.cards) {
      if (!c || !isString(c.question) || !isString(c.answer)) {
        return { valid: false, reason: 'Malformed card entry.' };
      }
    }
    return { valid: true };
  }

  return { valid: false, reason: 'Unknown mode.' };
}

/* ==========================================================================
   RESPONSE CLASSIFICATION
   Central helper both generation paths use to decide, from a raw text
   payload plus a finish reason, whether a response is usable, needs a
   compact retry, or should be surfaced as a controlled error.
   ========================================================================== */

export const RESPONSE_ISSUE = Object.freeze({
  OK: 'ok',
  EMPTY: 'empty',
  TRUNCATED_JSON: 'truncated_json',
  MALFORMED_JSON: 'malformed_json',
  INVALID_STRUCTURE: 'invalid_structure',
  SAFETY_BLOCK: 'safety_block',
  MAX_TOKENS_NO_TEXT: 'max_tokens_no_text'
});

// Never throws — always returns a structured { issue, completion, data } result.
export function classifyGeneratedResponse({ mode, text, finishReason }) {
  const completion = normalizeFinishReason(finishReason);

  if (completion === COMPLETION_CATEGORIES.SAFETY_BLOCK) {
    return { issue: RESPONSE_ISSUE.SAFETY_BLOCK, completion, data: null };
  }

  if (!text || !String(text).trim()) {
    const issue = completion === COMPLETION_CATEGORIES.MAX_TOKENS
      ? RESPONSE_ISSUE.MAX_TOKENS_NO_TEXT
      : RESPONSE_ISSUE.EMPTY;
    return { issue, completion, data: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const truncated = completion === COMPLETION_CATEGORIES.MAX_TOKENS || looksLikeTruncatedJson(text);
    return {
      issue: truncated ? RESPONSE_ISSUE.TRUNCATED_JSON : RESPONSE_ISSUE.MALFORMED_JSON,
      completion,
      data: null
    };
  }

  const structureCheck = validateDeckStructure(mode, parsed);
  if (!structureCheck.valid) {
    // A well-formed-JSON-but-incomplete structure while at MAX_TOKENS is
    // still a length problem, not "the model returned garbage".
    const truncated = completion === COMPLETION_CATEGORIES.MAX_TOKENS;
    return {
      issue: truncated ? RESPONSE_ISSUE.TRUNCATED_JSON : RESPONSE_ISSUE.INVALID_STRUCTURE,
      completion,
      data: null
    };
  }

  return { issue: RESPONSE_ISSUE.OK, completion, data: parsed };
}

// Whether a classified issue is a length problem worth one compact retry, as
// opposed to something a retry can't fix (safety block, garbage output
// unrelated to length, a plain empty response with a normal STOP reason).
export function isRetryableForLength(issue) {
  return issue === RESPONSE_ISSUE.TRUNCATED_JSON || issue === RESPONSE_ISSUE.MAX_TOKENS_NO_TEXT;
}

// Rough source-size tiers used to scale how much the model is asked to
// extract, so a long article isn't compressed into the same fixed handful
// of items as a short paragraph. Character-length based; image inputs pass
// 0 (unknown length) and always get the baseline tier.
function getSourceSizeTier(sourceLength) {
  const length = Number(sourceLength) || 0;
  if (length > 9000) return 'large';
  if (length > 3000) return 'medium';
  return 'default';
}

// Builds { schema, systemInstruction, userPrompt } for a validated study mode.
// Throws if `mode` isn't one of STUDY_MODES — callers must validate first.
// `sourceLength` (character count of the source text, 0/omitted for images)
// scales extraction counts so large source material isn't under-covered.
// `options.compact` requests a shorter/cheaper variant of the same mode,
// used only for the single internal length-triggered retry — never exposed
// as a user-controllable setting.
export function buildModeConfig(mode, academicSubject = '', sourceLength = 0, options = {}) {
  if (!isValidStudyMode(mode)) {
    throw new Error(`Unsupported study mode: ${mode}`);
  }

  const compact = !!options.compact;
  const safeSubject = sanitizeSubjectContext(academicSubject);
  const subjectPrefix = safeSubject ? `Focus context specifically on the subject: ${safeSubject}. ` : '';
  const sizeTier = getSourceSizeTier(sourceLength);

  let schema = {};
  let systemInstruction = '';
  let userPrompt = '';

  if (mode === 'summary') {
    schema = {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Catchy study card title' },
        subtitle: { type: 'string', description: 'Brief subject classification' },
        bullets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Core concept term (2-5 words max)' },
              content: { type: 'string', description: 'Insights detailing the concept (1-2 sentences maximum)' }
            },
            required: ['label', 'content']
          }
        },
        takeaway: { type: 'string', description: 'A single high-impact takeaway sentence' }
      },
      required: ['title', 'subtitle', 'bullets', 'takeaway']
    };

    const bulletRange = compact
      ? (sizeTier === 'large' ? 'between 6 and 8' : sizeTier === 'medium' ? 'between 4 and 6' : 'between 3 and 4')
      : (sizeTier === 'large' ? 'between 8 and 12' : sizeTier === 'medium' ? 'between 5 and 8' : 'between 3 and 5');
    const bulletSizeNote = sizeTier !== 'default'
      ? ' The source material is long — make sure every major concept is represented; do not compress multiple distinct ideas into a single bullet.'
      : '';
    const compactNote = compact
      ? ' Keep this response noticeably shorter than usual: use short, direct one-sentence bullet explanations and a brief takeaway, while still covering the highest-value concepts. Prioritize returning complete, valid JSON over maximum detail.'
      : '';

    systemInstruction = `You are a professional educational designer and summarization engine. ${subjectPrefix}Analyze the study source text/image. Generate a high-yield study summary that extracts critical terms. Keep definitions to-the-point. Format output STRICTLY as JSON adhering to the provided schema.`;
    userPrompt = `Perform a high-yield summary of the uploaded study reference material. Extract ${bulletRange} key concepts.${bulletSizeNote}${compactNote} Keep content academic, clear, and educational.`;

  } else if (mode === 'eli5') {
    schema = {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Sleek explanation title' },
        subtitle: { type: 'string', description: 'Topic context' },
        analogyTitle: { type: 'string', description: 'Title of the analogy used' },
        analogy: { type: 'string', description: 'A highly relatable analogy mapping the topic to simple concepts that a 5-year-old understands' },
        simpleExplanation: { type: 'string', description: 'A explanation of the core mechanics written in simple, clear language without using heavy terminology.' },
        funFact: { type: 'string', description: 'An engaging, fun, or memorable trivia fact related to the topic.' }
      },
      required: ['title', 'subtitle', 'analogyTitle', 'analogy', 'simpleExplanation', 'funFact']
    };

    const eli5SizeNote = sizeTier !== 'default'
      ? ' The source covers a lot of ground — make sure the explanation touches its full breadth rather than just the first part.'
      : '';
    const compactNote = compact
      ? ' Keep this response noticeably shorter than usual: settle on one strong analogy, keep the explanation concise but complete, and avoid repeating the same idea across multiple fields. Prioritize returning complete, valid JSON over maximum detail.'
      : '';

    systemInstruction = `You are a master scientific communicator and school tutor. ${subjectPrefix}Analyze the provided study material and translate it into a simple explanation suitable for a child (ELI5 mode). Avoid technical terminology. Adhere strictly to the JSON schema.`;
    userPrompt = `Explain this concept like I am 5 years old. Use a playful, understandable analogy and clear language.${eli5SizeNote}${compactNote}`;

  } else if (mode === 'notes') {
    schema = {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Comprehensive study card outline title' },
        subtitle: { type: 'string', description: 'Subject classification' },
        sections: {
          type: 'array',
          description: 'A detailed, hierarchical study outline of the material',
          items: {
            type: 'object',
            properties: {
              header: { type: 'string', description: 'Main concept header (e.g. key phase, topic, or main division)' },
              subsections: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    subHeader: { type: 'string', description: 'Sub-header diving into a specific subtopic or detail' },
                    bullets: {
                      type: 'array',
                      items: {
                        type: 'string',
                        description: 'A comprehensive bullet point detailing a key fact, detail, formula, or concept (1-2 sentences)'
                      }
                    }
                  },
                  required: ['subHeader', 'bullets']
                }
              }
            },
            required: ['header', 'subsections']
          }
        }
      },
      required: ['title', 'subtitle', 'sections']
    };

    const notesSizeNote = sizeTier !== 'default'
      ? ' The source material is long — use as many sections and subsections as needed to cover it fully; do not compress or skip content to save space.'
      : '';
    const compactNote = compact
      ? ' Keep this response noticeably shorter than usual: preserve every major section, but use shorter bullets and merge minor subsections together where reasonable. Avoid repetitive detail. Prioritize returning complete, valid JSON over maximum detail.'
      : '';

    systemInstruction = `You are a professional academic summarizer and study guide outline compiler. ${subjectPrefix}Analyze the study source text/image. Generate a highly structured, comprehensive, and detailed outline with Main Headers, Sub-Headers, and key bullet points. Do not omit crucial definitions, concepts, or details. Format output STRICTLY as JSON adhering to the provided schema.`;
    userPrompt = `Perform a comprehensive study outline of the provided study material. Organize it into main conceptual headers (sections), relevant sub-headers (subsections), and key detail bullet points (bullets).${notesSizeNote}${compactNote}`;

  } else { // flashcards
    schema = {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Study card deck name' },
        subtitle: { type: 'string', description: 'Context and scope' },
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'A clear, direct test question testing key principles' },
              answer: { type: 'string', description: 'The accurate, precise answer (1-2 sentences max)' }
            },
            required: ['question', 'answer']
          }
        }
      },
      required: ['title', 'subtitle', 'cards']
    };

    const cardCount = compact
      ? (sizeTier === 'large' ? 'between 6 and 8' : sizeTier === 'medium' ? 'between 4 and 6' : 'exactly 3')
      : (sizeTier === 'large' ? 'between 8 and 12' : sizeTier === 'medium' ? 'between 6 and 8' : 'exactly 4');
    const cardSizeNote = sizeTier !== 'default'
      ? ' The source material is long, so cover its full breadth rather than just the beginning.'
      : '';
    const compactNote = compact
      ? ' Keep this response noticeably shorter than usual: prioritize the highest-yield cards and keep answers concise. Prioritize returning complete, valid JSON over maximum detail.'
      : '';

    systemInstruction = `You are an academic flashcard creator. ${subjectPrefix}Analyze the material and formulate precise Q&A flashcards for study revisions. Avoid multiple choice. Keep questions clean and answers compact. Adhere strictly to the JSON schema.`;
    userPrompt = `Extract ${cardCount} high-yield Q&A study flashcards from the provided resource.${cardSizeNote}${compactNote} Focus on core details, dates, equations, or processes.`;
  }

  return { schema, systemInstruction, userPrompt };
}
