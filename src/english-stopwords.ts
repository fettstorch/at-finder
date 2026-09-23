/**
 * Conservative English stopwords for identity-search keywords. Negations and
 * action-bearing verbs intentionally remain meaningful.
 */
export const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the",
  "i", "me", "my", "mine", "myself",
  "we", "us", "our", "ours", "ourselves",
  "you", "your", "yours", "yourself", "yourselves",
  "he", "him", "his", "himself",
  "she", "her", "hers", "herself",
  "it", "its", "itself",
  "they", "them", "their", "theirs", "themselves",
  "this", "that", "these", "those",
  "what", "which", "who", "whom",
  "am", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having",
  "and", "but", "or", "if", "because", "as", "while", "until",
  "of", "at", "by", "for", "with", "about", "against",
  "between", "into", "through", "during", "before", "after",
  "above", "below", "to", "from", "in", "out", "on", "off",
  "over", "under",
  "again", "further", "then", "once",
  "here", "there", "when", "where", "why", "how",
  "so", "too", "very",
]);

const TERM_PATTERN = /[\p{L}\p{N}]+/gu;

/** Extracts unique, case-insensitive Unicode letter/number terms. */
export function tokenizeTerms(value: string) {
  return [...new Set(value.toLocaleLowerCase().match(TERM_PATTERN) ?? [])];
}

/** Extracts only terms useful for English keyword matching and highlighting. */
export function tokenizeEnglishKeywords(value: string) {
  return tokenizeTerms(value).filter((term) => !ENGLISH_STOPWORDS.has(term));
}
