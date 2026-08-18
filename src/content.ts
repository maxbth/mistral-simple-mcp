/**
 * Flattens an assistant message's content to text.
 *
 * `AssistantMessage.content` is typed `string | Array<ContentChunk> | null | undefined`. A text
 * completion returns the string form in practice, but the array form is reachable and
 * well-typed, so both are handled rather than cast away. Non-text chunks — images, documents,
 * thinking blocks — carry no completion text and are dropped.
 *
 * The parameter is `unknown` rather than the SDK's `ContentChunk` union: this module exists to
 * narrow an untrusted shape, and importing the union would make it the SDK's job to prove the
 * narrowing is needed. An empty string is returned as-is; only a genuinely absent or
 * text-free content returns `undefined`, so callers can tell "the model said nothing" from
 * "the model returned no content at all".
 */
export function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts: Array<string> = [];
  for (const chunk of content) {
    if (typeof chunk === 'object' && chunk !== null) {
      const {type, text} = chunk as {
        type?: unknown;
        text?: unknown;
      };
      if (type === 'text' && typeof text === 'string') {
        parts.push(text);
      }
    }
  }

  return parts.length ? parts.join('') : undefined;
}
