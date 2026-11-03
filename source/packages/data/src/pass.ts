import type { IrArtifact } from "./ir";

export interface PassContext {
  readonly signal: AbortSignal;
  reportProgress(progress: number, message?: string): void;
}

export interface PassResult<TOutput extends IrArtifact> {
  readonly output: TOutput;
  readonly diagnostics: readonly PassDiagnostic[];
}

export interface PassDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
}

export interface Pass<
  TInput extends IrArtifact,
  TOutput extends IrArtifact,
  TParams = unknown,
> {
  readonly id: string;
  readonly version: number;
  execute(
    input: TInput,
    params: TParams,
    context: PassContext,
  ): Promise<PassResult<TOutput>>;
}
