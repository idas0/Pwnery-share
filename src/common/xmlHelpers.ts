import { convert } from 'xmlbuilder2';

// ---------------------------------------------------------------------------
// Namespace-agnostic XML helpers
// ---------------------------------------------------------------------------

/**
 * Recursively strips namespace prefixes from every key in a parsed XML object.
 * e.g. "ns0:ORDER_ID" → "ORDER_ID", "bmecat:CURRENCY" → "CURRENCY"
 */
export function stripNamespaces(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(stripNamespaces);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const stripped = key.includes(':') ? key.split(':').pop()! : key;
      if (!(stripped in result)) {
        result[stripped] = stripNamespaces(value);
      }
    }
    return result;
  }
  return obj;
}

/**
 * Recursively collect every value found under a given key name.
 * Handles both plain string values and xmlbuilder2 text-node objects ({ '#': '...' }).
 */
export function collectValues(obj: unknown, targetKey: string): string[] {
  const results: string[] = [];

  function walk(node: unknown) {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === targetKey) {
          const text = extractText(value);
          if (text) results.push(text);
        }
        walk(value);
      }
    }
  }

  walk(obj);
  return [...new Set(results)];
}

/**
 * Extract the first value found under a given key. Returns undefined if not found.
 */
export function collectFirst(obj: unknown, targetKey: string): string | undefined {
  return collectValues(obj, targetKey)[0];
}

/**
 * Extract a plain text string from a value that may be a string, a number,
 * or an xmlbuilder2 text-node object like { '#': 'text' }.
 */
export function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'object' && value !== null && '#' in (value as any)) {
    const text = (value as any)['#'];
    if (typeof text === 'string') {
      const trimmed = text.trim();
      return trimmed || undefined;
    }
  }
  return undefined;
}

/**
 * Parse an XML string into a namespace-stripped plain object.
 */
export function parseXml(xml: string): Record<string, unknown> {
  const raw = convert(xml, { format: 'object' }) as Record<string, unknown>;
  return stripNamespaces(raw) as Record<string, unknown>;
}

/**
 * Find nodes matching a key, returning the full sub-objects (not just text values).
 * Useful for extracting structured elements like DISPATCHNOTIFICATION_ITEM.
 */
export function collectNodes(obj: unknown, targetKey: string): unknown[] {
  const results: unknown[] = [];

  function walk(node: unknown) {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === targetKey) {
          if (Array.isArray(value)) {
            results.push(...value);
          } else {
            results.push(value);
          }
        }
        walk(value);
      }
    }
  }

  walk(obj);
  return results;
}
