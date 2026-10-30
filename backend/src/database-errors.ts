/** Drizzle wraps PostgreSQL errors. Never return SQL, parameters or driver messages to the client. */
export function databaseErrorCode(error: unknown): string | undefined {
  for (let depth = 0; depth < 5 && error && typeof error === 'object'; depth++) {
    if ('code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code))
      return error.code;
    error = 'cause' in error ? error.cause : undefined;
  }
  return undefined;
}
