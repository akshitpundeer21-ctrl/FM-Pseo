/**
 * Skill-layer errors, mapped onto the app's existing typed error hierarchy so
 * the API layer shapes and statuses them exactly like every other endpoint.
 */
import { AppError } from "@/core/errors";

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super("NOT_FOUND", id ? `${entity} ${id} was not found` : `${entity} was not found`);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_FAILED", message, { details });
  }
}

/** A legal request that conflicts with the current state (409). */
export class ConflictLikeError extends AppError {
  constructor(message: string, details?: unknown) {
    super("CONFLICT", message, { details });
  }
}
