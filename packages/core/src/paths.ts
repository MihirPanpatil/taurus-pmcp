const ID_PATTERNS = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{16,}$/i,
  /^(?=.*\d)[A-Za-z0-9_-]{12,}$/,
];

export function singular(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + 'y';
  if (/(ss|us)$/i.test(word)) return word;
  if (/s$/i.test(word)) return word.slice(0, -1);
  return word;
}

function camel(word: string): string {
  return word.toLowerCase().replace(/[-_ ]+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function looksLikeId(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  return ID_PATTERNS.some((p) => p.test(decoded));
}

/**
 * Replaces ID-like path segments with named parameters:
 * "/api/projects/12/tasks" -> "/api/projects/{projectId}/tasks".
 */
export function templatePath(pathname: string): { template: string; params: string[] } {
  const segments = pathname.split('/');
  const params: string[] = [];
  const out = segments.map((segment, i) => {
    if (!segment || !looksLikeId(segment)) return segment;
    const previous = segments[i - 1];
    let name = previous && !looksLikeId(previous) ? `${camel(singular(previous))}Id` : 'id';
    let n = 2;
    while (params.includes(name)) name = `${name.replace(/\d+$/, '')}${n++}`;
    params.push(name);
    return `{${name}}`;
  });
  return { template: out.join('/'), params };
}

/** Fills "{name}" placeholders, URL-encoding each value. */
export function fillPath(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`missing path parameter "${name}"`);
    }
    return encodeURIComponent(String(value));
  });
}
