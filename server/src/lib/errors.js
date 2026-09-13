export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code ?? message.toLowerCase().replaceAll(' ', '_');
  }
}

export const badRequest = (msg, code) => new HttpError(400, msg, code);
export const unauthorized = (msg = 'not authenticated', code) => new HttpError(401, msg, code);
export const conflict = (msg, code) => new HttpError(409, msg, code);
export const notFound = (msg = 'not found', code = 'not_found') => new HttpError(404, msg, code);
