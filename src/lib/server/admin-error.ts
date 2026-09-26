/** An admin action that cannot run. The status is the matching HTTP status. */
export class AdminActionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string
  ) {
    super(message);
  }
}
