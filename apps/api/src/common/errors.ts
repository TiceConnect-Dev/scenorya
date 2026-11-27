import { HttpException, HttpStatus } from '@nestjs/common';

/** Erreur applicative avec code stable exploitable par le client. */
export class AppError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, details?: unknown) {
    super({ statusCode: status, code, message, details }, status);
  }
}

export const Forbidden = (code: string, message: string, details?: unknown) =>
  new AppError(HttpStatus.FORBIDDEN, code, message, details);
export const Unauthorized = (message = 'Authentification requise.') =>
  new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', message);
export const NotFound = (message = 'Ressource introuvable.') => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', message);
export const Conflict = (code: string, message: string, details?: unknown) =>
  new AppError(HttpStatus.CONFLICT, code, message, details);
export const BadRequest = (code: string, message: string, details?: unknown) =>
  new AppError(HttpStatus.BAD_REQUEST, code, message, details);
