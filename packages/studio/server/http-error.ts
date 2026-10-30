/** Shared HTTP capability errors, independent of database and application initialization. */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
