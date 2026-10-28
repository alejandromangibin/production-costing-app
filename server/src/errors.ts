/** An error the owner can understand and fix. Sent to the browser as-is. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** A short machine-readable reason the web app can act on (for example "login_required"). */
    public code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const notFound = (m: string) => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);
export const unauthorized = (m = 'Please log in.') => new HttpError(401, m, 'login_required');
export const forbidden = (m = 'You do not have access to this.') => new HttpError(403, m, 'forbidden');
