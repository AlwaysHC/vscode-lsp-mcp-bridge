export interface GraphTraversalLimits {
  maxDepth: number;
  maxNodes: number;
}

export interface TraversedGraphNode<T> {
  value: T;
  depth: number;
}

export interface BoundedGraphTraversal<T> {
  nodes: TraversedGraphNode<T>[];
  truncated: boolean;
  depthLimited: boolean;
}

export async function traverseBoundedGraph<T>(
  roots: readonly T[],
  keyOf: (value: T) => string,
  expand: (value: T, depth: number) => Promise<readonly T[]>,
  limits: GraphTraversalLimits
): Promise<BoundedGraphTraversal<T>> {
  if (!Number.isInteger(limits.maxDepth) || limits.maxDepth < 0) {
    throw new Error("maxDepth must be a non-negative integer.");
  }
  if (!Number.isInteger(limits.maxNodes) || limits.maxNodes < 1) {
    throw new Error("maxNodes must be a positive integer.");
  }

  const seen = new Set<string>();
  const queue: TraversedGraphNode<T>[] = [];
  let truncated = false;
  let depthLimited = false;

  const enqueue = (value: T, depth: number): void => {
    const key = keyOf(value);
    if (seen.has(key)) {
      return;
    }
    if (seen.size >= limits.maxNodes) {
      truncated = true;
      return;
    }

    seen.add(key);
    queue.push({ value, depth });
  };

  for (const root of roots) {
    enqueue(root, 0);
  }

  const nodes: TraversedGraphNode<T>[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    nodes.push(current);
    if (current.depth >= limits.maxDepth) {
      depthLimited = true;
      continue;
    }

    for (const related of await expand(current.value, current.depth)) {
      enqueue(related, current.depth + 1);
    }
  }

  return { nodes, truncated, depthLimited };
}

export function boundedInteger(
  value: unknown,
  key: string,
  options: { defaultValue: number; minimum?: number; maximum: number }
): number {
  const minimum = options.minimum ?? 1;
  if (value === undefined || value === null) {
    return options.defaultValue;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > options.maximum) {
    throw new Error(`Expected ${key} to be an integer from ${minimum} through ${options.maximum}.`);
  }

  return value;
}

export function normalizeComparableCode(value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : String(value).toLowerCase();
}
