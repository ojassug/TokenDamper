import type { ContextItem } from '../model/types';
import { selectValidator } from '../validation/ast';
import { resolveParserBackend } from './registry';
import type { EngineMode, ParserAdapter } from './types';

/**
 * Languages whose function bodies only a Deep backend can find (R4, spec §2).
 *
 * Core names them through its Fast lexers, which is what makes them reachable at all (§81's
 * JavaScript lesson), but has no region scanner for either. **Every rule that treats them
 * differently asks this module**, so the region gate (`regionElisionLanguage`), the drift gate's
 * symbols (`DriftTracker`) and the language-support report cannot disagree about which items are
 * deep-only.
 */
export const DEEP_ONLY_LANGUAGES: ReadonlyArray<'c' | 'csharp'> = Object.freeze(['c', 'csharp']);

export function isDeepOnlyLanguage(language: string | undefined): boolean {
  return language !== undefined && (DEEP_ONLY_LANGUAGES as ReadonlyArray<string>).includes(language);
}

/** The backend answering for a deep-only item in deep mode; `undefined` otherwise. */
export function deepOnlyBackend(item: ContextItem, mode: EngineMode): ParserAdapter | undefined {
  if (mode !== 'deep') return undefined;
  const language = selectValidator(item, 'fast')?.language;
  return language !== undefined && isDeepOnlyLanguage(language) ? resolveParserBackend(language) : undefined;
}
