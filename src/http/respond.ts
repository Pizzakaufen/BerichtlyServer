// Einheitliche Antworten ({data, meta} bzw. {error}) sowie Body-, Query- und Pfadparameter.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, badParameter, Codes } from '../domain/errors.ts';
import { asObject, type Json, parseUuid } from '../validation/validator.ts';
import type { Principal } from '../services/auth.ts';
import type { Logger } from '../util/logger.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    log2: Logger; // Logger mit request_id
    startedAt: bigint;
  }
}

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendData(reply: FastifyReply, status: number, data: unknown) {
  return reply.code(status).type(JSON_TYPE).send(JSON.stringify({ data }));
}

export interface Page {
  page: number;
  limit: number;
  offset: number;
}

export function sendPage(reply: FastifyReply, data: unknown[], p: Page, total: number) {
  return reply.code(200).type(JSON_TYPE).send(JSON.stringify({
    data,
    meta: { page: p.page, limit: p.limit, total, hasMore: p.offset + p.limit < total },
  }));
}

export function sendError(reply: FastifyReply, err: ApiError) {
  const req = reply.request;
  return reply.code(err.status).type(JSON_TYPE).send(JSON.stringify({
    error: {
      code: err.code, message: err.message, requestId: String(req.id), details: err.details, conflict: err.conflict,
    },
  }));
}

export const principal = (req: FastifyRequest): Principal => req.principal!;

/**
 * Liest den JSON-Body. Nur application/json wird akzeptiert; unbekannte Felder werden ignoriert, damit
 * neuere App-Versionen mit älteren Servern funktionieren. Die Größe begrenzt bereits Fastify (bodyLimit).
 */
export function readJson(req: FastifyRequest): Json {
  const mediaType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new ApiError(415, Codes.UnsupportedMediaType, 'Nicht unterstützter Content-Type. Erwartet wird application/json.');
  }
  const raw = req.body;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
  let parsed: unknown;
  try {
    // Schlüssel wie "__proto__" werden abgelehnt (Schutz vor Prototype Pollution).
    parsed = JSON.parse(text, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('unsafe key');
      return value;
    });
  } catch {
    throw invalidJson();
  }
  return asObject(parsed);
}

const invalidJson = () =>
  new ApiError(400, Codes.InvalidRequestBody, 'Der Request-Body ist kein gültiges JSON oder hat eine falsche Struktur.');

/** Erster Wert eines Query-Parameters ("" wenn nicht vorhanden). */
export function query(req: FastifyRequest, name: string): string {
  const v = (req.query as Record<string, string | string[] | undefined>)[name];
  if (v === undefined) return '';
  return Array.isArray(v) ? (v[0] ?? '') : v;
}

/** Ganzzahl wie strconv.Atoi (optionales Vorzeichen, nur Ziffern). */
export function parseIntStrict(raw: string): number | null {
  if (!/^[+-]?\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

export function queryInt(req: FastifyRequest, name: string, def: number, min: number, max: number): number {
  const raw = query(req, name);
  if (raw === '') return def;
  const v = parseIntStrict(raw);
  if (v === null) throw badParameter(name, 'not_an_integer');
  if (v < min || v > max) throw badParameter(name, `out_of_range:${min}..${max}`);
  return v;
}

export function pageParams(req: FastifyRequest): Page {
  const page = queryInt(req, 'page', 1, 1, 100000);
  const limit = queryInt(req, 'limit', 50, 1, 100);
  return { page, limit, offset: (page - 1) * limit };
}

export function pathParam(req: FastifyRequest, name: string): string {
  return (req.params as Record<string, string>)[name] ?? '';
}

export function pathUuid(req: FastifyRequest, name: string): string {
  const id = parseUuid(pathParam(req, name));
  if (!id) throw badParameter(name, 'invalid_uuid');
  return id;
}
