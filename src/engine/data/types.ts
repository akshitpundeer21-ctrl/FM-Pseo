/**
 * Dynamic Data Engine contracts.
 *
 * Every value a component renders arrives as a `DataPoint` carrying its own
 * provenance. A component may not render a value that has no provenance, and
 * the quality gate rejects pages whose time-sensitive values are unverified.
 */
import type { VerificationStatus } from "@/core/types/enums";

export interface DataPoint<T = unknown> {
  /** Dot path this value was bound to, e.g. "route.typicalDurationMinutes". */
  path: string;
  value: T;
  unit?: string;
  sourceKey: string;
  sourceName: string;
  sourceUrl?: string;
  retrievedAt: string;
  /** 0..1 - how much the engine trusts this value. */
  confidence: number;
  verificationStatus: VerificationStatus;
  /** Prices, schedules, seat availability, policies: never invented. */
  isTimeSensitive: boolean;
  isMock: boolean;
  /** Human-readable explanation of how the value was produced. */
  method?: string;
}

export interface DataContext {
  /** Flattened value tree used for template interpolation + conditions. */
  values: Record<string, unknown>;
  /** Provenance for every leaf in `values`. */
  points: DataPoint[];
  /** Bindings a component asked for that could not be resolved. */
  missing: string[];
  /** True when any contributing source is a mock dataset. */
  containsMock: boolean;
}

export interface DataSourceAdapter {
  readonly key: string;
  readonly name: string;
  readonly isMock: boolean;
  readonly trustLevel: number;
  /** True when the adapter can actually serve requests right now. */
  isAvailable(): Promise<boolean> | boolean;
  /** Resolve a namespace ("route", "airport", "airline", "offers"). */
  resolve(namespace: string, params: Record<string, string>): Promise<DataPoint[]>;
  /** Namespaces this adapter can answer. */
  supports(namespace: string): boolean;
}

export function point<T>(
  path: string,
  value: T,
  base: {
    sourceKey: string;
    sourceName: string;
    retrievedAt: string;
    confidence: number;
    isMock: boolean;
    isTimeSensitive?: boolean;
    verificationStatus?: VerificationStatus;
    unit?: string;
    sourceUrl?: string;
    method?: string;
  },
): DataPoint<T> {
  return {
    path,
    value,
    unit: base.unit,
    sourceKey: base.sourceKey,
    sourceName: base.sourceName,
    sourceUrl: base.sourceUrl,
    retrievedAt: base.retrievedAt,
    confidence: base.confidence,
    verificationStatus: base.verificationStatus ?? "UNVERIFIED",
    isTimeSensitive: base.isTimeSensitive ?? false,
    isMock: base.isMock,
    method: base.method,
  };
}

/** Build the nested value tree from a flat list of dotted data points. */
export function materialise(points: DataPoint[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of points) {
    const parts = p.path.split(".");
    let cur: any = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
      cur = cur[key];
    }
    cur[parts[parts.length - 1]] = p.value;
  }
  return out;
}

export function lookup(values: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), values);
}
