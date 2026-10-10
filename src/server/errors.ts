export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "ZodError"
  )
    return "INVALID_ARGUMENTS";
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  )
    return "UPSTREAM_TIMEOUT";
  return error instanceof AppError ? error.code : "INTERNAL_ERROR";
}
export function errorResponse(error: unknown): Response {
  return Response.json(
    { error: errorCode(error) },
    {
      status:
        error instanceof AppError
          ? error.status
          : errorCode(error) === "INVALID_ARGUMENTS"
            ? 400
            : 500,
      headers: { "cache-control": "no-store" },
    },
  );
}
