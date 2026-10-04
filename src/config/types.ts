import type {
  LogLevel,
  OptimizationBudget,
  OptimizationMode,
  ResolvedConfig,
} from '../core/model';
import type { EngineMode } from '../core/parser/mode';

/**
 * The serialized configuration shape accepted from disk.
 */
export interface ConfigFileShape {
  readonly configSchemaVersion?: string;
  readonly app?: {
    readonly name?: string;
    readonly version?: string;
    /** Withdrawn in 2.0.0 (DECISIONS §87). Loaded, never read, and reported as a notice. */
    readonly mode?: unknown;
  };
  /** The engine backend (2.0.0): `fast` (default) or `deep`. Read by `optimize` only. */
  readonly engine?: {
    readonly mode?: EngineMode;
  };
  readonly planner?: {
    readonly defaultMode?: OptimizationMode;
  };
  readonly budget?: Partial<OptimizationBudget>;
  readonly validation?: {
    readonly minimumConfidence?: number;
  };
  readonly logging?: {
    readonly level?: LogLevel;
  };
}

/**
 * The supported CLI overrides for the frozen MVP configuration loader.
 */
export interface ConfigOverrides {
  engineMode?: EngineMode;
  plannerMode?: OptimizationMode;
  minimumConfidence?: number;
  logLevel?: LogLevel;
  budget?: Partial<OptimizationBudget>;
}

/**
 * The options accepted by the configuration loader.
 */
export interface LoadConfigOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cliOverrides?: Partial<ConfigOverrides>;
}

/**
 * The fully resolved configuration returned by the loader.
 */
export type TokenDamperConfig = ResolvedConfig & {
  readonly configSchemaVersion?: string;
  /** Which backend discovers regions. Read by `optimize` only; bench and mcp refuse `deep`. */
  readonly engineMode: EngineMode;
  /** Startup notices — withdrawn keys still present. Written once to stderr by the CLI. */
  readonly notices: ReadonlyArray<string>;
};
