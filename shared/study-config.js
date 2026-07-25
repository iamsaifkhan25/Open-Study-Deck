/* ==========================================================================
   SHARED STUDY CONFIG
   Single source of truth for study modes, JSON schemas, and prompt
   construction. Used by the browser BYOK path (app.js) and the Cloudflare
   guest generation function (functions/api/generate-study-deck.js).

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

// Builds { schema, systemInstruction, userPrompt } for a validated study mode.
// Throws if `mode` isn't one of STUDY_MODES — callers must validate first.
export function buildModeConfig(mode, academicSubject = '') {
  if (!isValidStudyMode(mode)) {
    throw new Error(`Unsupported study mode: ${mode}`);
  }

  const safeSubject = sanitizeSubjectContext(academicSubject);
  const subjectPrefix = safeSubject ? `Focus context specifically on the subject: ${safeSubject}. ` : '';

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

    systemInstruction = `You are a professional educational designer and summarization engine. ${subjectPrefix}Analyze the study source text/image. Generate a high-yield study summary that extracts critical terms. Keep definitions to-the-point. Format output STRICTLY as JSON adhering to the provided schema.`;
    userPrompt = `Perform a high-yield summary of the uploaded study reference material. Extract between 3 and 5 key concepts. Keep content academic, clear, and educational.`;

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

    systemInstruction = `You are a master scientific communicator and school tutor. ${subjectPrefix}Analyze the provided study material and translate it into a simple explanation suitable for a child (ELI5 mode). Avoid technical terminology. Adhere strictly to the JSON schema.`;
    userPrompt = `Explain this concept like I am 5 years old. Use a playful, understandable analogy and clear language.`;

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

    systemInstruction = `You are a professional academic summarizer and study guide outline compiler. ${subjectPrefix}Analyze the study source text/image. Generate a highly structured, comprehensive, and detailed outline with Main Headers, Sub-Headers, and key bullet points. Do not omit crucial definitions, concepts, or details. Format output STRICTLY as JSON adhering to the provided schema.`;
    userPrompt = `Perform a comprehensive study outline of the provided study material. Organize it into main conceptual headers (sections), relevant sub-headers (subsections), and key detail bullet points (bullets).`;

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

    systemInstruction = `You are an academic flashcard creator. ${subjectPrefix}Analyze the material and formulate precise Q&A flashcards for study revisions. Avoid multiple choice. Keep questions clean and answers compact. Adhere strictly to the JSON schema.`;
    userPrompt = `Extract exactly 4 high-yield Q&A study flashcards from the provided resource. Focus on core details, dates, equations, or processes.`;
  }

  return { schema, systemInstruction, userPrompt };
}
