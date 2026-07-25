import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  getOutputTokenBudget,
  OUTPUT_TOKEN_BUDGETS,
  resolveGuestOutputTokenBudget,
  normalizeFinishReason,
  COMPLETION_CATEGORIES,
  looksLikeTruncatedJson,
  validateDeckStructure,
  classifyGeneratedResponse,
  RESPONSE_ISSUE,
  isRetryableForLength,
  buildModeConfig
} from '../shared/study-config.js';

describe('output token budgets', () => {
  test('returns the mode-aware default for every study mode', () => {
    assert.equal(getOutputTokenBudget('summary'), 4096);
    assert.equal(getOutputTokenBudget('eli5'), 4096);
    assert.equal(getOutputTokenBudget('flashcards'), 6144);
    assert.equal(getOutputTokenBudget('notes'), 12288);
  });

  test('falls back to the summary budget for an unknown mode', () => {
    assert.equal(getOutputTokenBudget('not-a-mode'), OUTPUT_TOKEN_BUDGETS.summary);
  });

  test('guest override: missing/empty env value uses the mode default', () => {
    assert.equal(resolveGuestOutputTokenBudget('notes', undefined), 12288);
    assert.equal(resolveGuestOutputTokenBudget('notes', ''), 12288);
    assert.equal(resolveGuestOutputTokenBudget('notes', null), 12288);
  });

  test('guest override: valid in-range integer is honored', () => {
    assert.equal(resolveGuestOutputTokenBudget('summary', '8000'), 8000);
  });

  test('guest override: out-of-range or non-integer values fall back to the default', () => {
    assert.equal(resolveGuestOutputTokenBudget('summary', '100'), 4096); // below min
    assert.equal(resolveGuestOutputTokenBudget('summary', '999999'), 4096); // above max
    assert.equal(resolveGuestOutputTokenBudget('summary', 'not-a-number'), 4096);
    assert.equal(resolveGuestOutputTokenBudget('summary', '4096.5'), 4096); // not an integer
  });
});

describe('finish reason normalization', () => {
  test('maps provider finish reasons to internal categories', () => {
    assert.equal(normalizeFinishReason('STOP'), COMPLETION_CATEGORIES.COMPLETE);
    assert.equal(normalizeFinishReason('MAX_TOKENS'), COMPLETION_CATEGORIES.MAX_TOKENS);
    assert.equal(normalizeFinishReason('SAFETY'), COMPLETION_CATEGORIES.SAFETY_BLOCK);
    assert.equal(normalizeFinishReason('PROHIBITED_CONTENT'), COMPLETION_CATEGORIES.SAFETY_BLOCK);
    assert.equal(normalizeFinishReason('RECITATION'), COMPLETION_CATEGORIES.MODEL_ERROR);
    assert.equal(normalizeFinishReason(undefined), COMPLETION_CATEGORIES.UNKNOWN);
    assert.equal(normalizeFinishReason('SOMETHING_NEW'), COMPLETION_CATEGORIES.UNKNOWN);
  });

  test('is case-insensitive', () => {
    assert.equal(normalizeFinishReason('stop'), COMPLETION_CATEGORIES.COMPLETE);
  });
});

describe('truncated JSON heuristic', () => {
  test('flags text that ends mid-string/mid-token', () => {
    assert.equal(looksLikeTruncatedJson('{"title": "Foo", "bullets": [{"label": "A", "content": "unfinished'), true);
  });

  test('flags unbalanced braces even if the last char looks closed', () => {
    assert.equal(looksLikeTruncatedJson('{"title": "Foo", "bullets": [{"label": "A"}'), true);
  });

  test('does not flag well-formed, balanced JSON', () => {
    assert.equal(looksLikeTruncatedJson('{"title": "Foo", "bullets": []}'), false);
  });

  test('handles empty/non-string input safely', () => {
    assert.equal(looksLikeTruncatedJson(''), false);
    assert.equal(looksLikeTruncatedJson(null), false);
    assert.equal(looksLikeTruncatedJson(undefined), false);
  });
});

describe('deck structure validation', () => {
  test('valid summary deck passes', () => {
    const result = validateDeckStructure('summary', {
      title: 't', subtitle: 's',
      bullets: [{ label: 'a', content: 'b' }],
      takeaway: 'x'
    });
    assert.equal(result.valid, true);
  });

  test('summary deck missing bullets fails', () => {
    const result = validateDeckStructure('summary', { title: 't', subtitle: 's', bullets: [], takeaway: 'x' });
    assert.equal(result.valid, false);
  });

  test('summary deck with malformed bullet entry fails', () => {
    const result = validateDeckStructure('summary', {
      title: 't', subtitle: 's', bullets: [{ label: 'a' }], takeaway: 'x'
    });
    assert.equal(result.valid, false);
  });

  test('valid eli5 deck passes', () => {
    const result = validateDeckStructure('eli5', {
      title: 't', subtitle: 's', analogyTitle: 'a', analogy: 'b', simpleExplanation: 'c', funFact: 'd'
    });
    assert.equal(result.valid, true);
  });

  test('eli5 deck missing funFact fails', () => {
    const result = validateDeckStructure('eli5', {
      title: 't', subtitle: 's', analogyTitle: 'a', analogy: 'b', simpleExplanation: 'c'
    });
    assert.equal(result.valid, false);
  });

  test('valid notes deck passes', () => {
    const result = validateDeckStructure('notes', {
      title: 't', subtitle: 's',
      sections: [{ header: 'H', subsections: [{ subHeader: 'S', bullets: ['one', 'two'] }] }]
    });
    assert.equal(result.valid, true);
  });

  test('notes deck with non-string bullet fails', () => {
    const result = validateDeckStructure('notes', {
      title: 't', subtitle: 's',
      sections: [{ header: 'H', subsections: [{ subHeader: 'S', bullets: ['ok', 42] }] }]
    });
    assert.equal(result.valid, false);
  });

  test('notes deck with empty sections fails', () => {
    const result = validateDeckStructure('notes', { title: 't', subtitle: 's', sections: [] });
    assert.equal(result.valid, false);
  });

  test('valid flashcards deck passes', () => {
    const result = validateDeckStructure('flashcards', {
      title: 't', subtitle: 's', cards: [{ question: 'q', answer: 'a' }]
    });
    assert.equal(result.valid, true);
  });

  test('flashcards deck with malformed card fails', () => {
    const result = validateDeckStructure('flashcards', {
      title: 't', subtitle: 's', cards: [{ question: 'q' }]
    });
    assert.equal(result.valid, false);
  });

  test('non-object data fails for any mode', () => {
    assert.equal(validateDeckStructure('summary', null).valid, false);
    assert.equal(validateDeckStructure('summary', 'a string').valid, false);
    assert.equal(validateDeckStructure('summary', []).valid, false);
  });
});

describe('classifyGeneratedResponse', () => {
  test('safety block takes priority over everything else', () => {
    const result = classifyGeneratedResponse({ mode: 'summary', text: '{}', finishReason: 'SAFETY' });
    assert.equal(result.issue, RESPONSE_ISSUE.SAFETY_BLOCK);
  });

  test('empty text with a normal STOP reason is EMPTY, not a length problem', () => {
    const result = classifyGeneratedResponse({ mode: 'summary', text: '', finishReason: 'STOP' });
    assert.equal(result.issue, RESPONSE_ISSUE.EMPTY);
    assert.equal(isRetryableForLength(result.issue), false);
  });

  test('empty text with MAX_TOKENS is a retryable length problem', () => {
    const result = classifyGeneratedResponse({ mode: 'summary', text: '', finishReason: 'MAX_TOKENS' });
    assert.equal(result.issue, RESPONSE_ISSUE.MAX_TOKENS_NO_TEXT);
    assert.equal(isRetryableForLength(result.issue), true);
  });

  test('cut-off JSON at MAX_TOKENS is retryable truncated_json', () => {
    const result = classifyGeneratedResponse({
      mode: 'summary',
      text: '{"title": "Foo", "subtitle": "Bar", "bullets": [{"label": "A", "content": "unfinished',
      finishReason: 'MAX_TOKENS'
    });
    assert.equal(result.issue, RESPONSE_ISSUE.TRUNCATED_JSON);
    assert.equal(isRetryableForLength(result.issue), true);
  });

  test('syntactically invalid but balanced/closed JSON with STOP is malformed_json, not retryable', () => {
    // Unquoted key — invalid JSON syntax, but braces/quotes are still
    // balanced and closed, so this is NOT truncation-shaped.
    const result = classifyGeneratedResponse({ mode: 'summary', text: '{title: "Foo"}', finishReason: 'STOP' });
    assert.equal(result.issue, RESPONSE_ISSUE.MALFORMED_JSON);
    assert.equal(isRetryableForLength(result.issue), false);
  });

  test('valid JSON but wrong structure is invalid_structure, not retryable', () => {
    const result = classifyGeneratedResponse({
      mode: 'summary',
      text: JSON.stringify({ foo: 'bar' }),
      finishReason: 'STOP'
    });
    assert.equal(result.issue, RESPONSE_ISSUE.INVALID_STRUCTURE);
    assert.equal(isRetryableForLength(result.issue), false);
  });

  test('valid, complete, well-structured deck is OK', () => {
    const deck = { title: 't', subtitle: 's', bullets: [{ label: 'a', content: 'b' }], takeaway: 'x' };
    const result = classifyGeneratedResponse({ mode: 'summary', text: JSON.stringify(deck), finishReason: 'STOP' });
    assert.equal(result.issue, RESPONSE_ISSUE.OK);
    assert.deepEqual(result.data, deck);
  });

  test('valid JSON but incomplete structure while at MAX_TOKENS is treated as truncated (retryable)', () => {
    // Model hit the token limit right after finishing "bullets" but before "takeaway".
    const partialDeck = { title: 't', subtitle: 's', bullets: [{ label: 'a', content: 'b' }] };
    const result = classifyGeneratedResponse({
      mode: 'summary',
      text: JSON.stringify(partialDeck),
      finishReason: 'MAX_TOKENS'
    });
    assert.equal(result.issue, RESPONSE_ISSUE.TRUNCATED_JSON);
    assert.equal(isRetryableForLength(result.issue), true);
  });
});

describe('buildModeConfig compact retry variant', () => {
  test('compact option changes the prompt without changing the schema shape', () => {
    const normal = buildModeConfig('flashcards', '', 500);
    const compact = buildModeConfig('flashcards', '', 500, { compact: true });
    assert.deepEqual(normal.schema, compact.schema);
    assert.notEqual(normal.userPrompt, compact.userPrompt);
    assert.match(compact.userPrompt, /shorter than usual/);
  });

  test('throws for an invalid mode', () => {
    assert.throws(() => buildModeConfig('bogus-mode'));
  });
});
