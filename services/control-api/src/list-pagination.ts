import { BadRequestException } from "@nestjs/common";
import { isUUID } from "class-validator";
import type { FastifyReply } from "fastify";

const MAX_PAGE_SIZE = 200;

export type ListPageQuery = { cursor?: unknown; limit?: unknown };

export function listLimit(value: unknown) {
  if (value === undefined) return MAX_PAGE_SIZE;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,2}$/u.test(value) || Number(value) > MAX_PAGE_SIZE) {
    throw new BadRequestException("Page limit must be an integer from 1 to " + MAX_PAGE_SIZE);
  }
  return Number(value);
}

export function listCursor(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !isUUID(value)) throw new BadRequestException("Page cursor is invalid");
  return value;
}

export function takeListPage<T>(rows: T[], limit: number, key: (row: T) => string) {
  const items = rows.slice(0, limit);
  const next_cursor = rows.length > limit ? key(items[items.length - 1]!) : null;
  return { items, next_cursor };
}

export function withListCursor<T>(
  reply: Pick<FastifyReply, "header">,
  page: { items: T[]; next_cursor: string | null },
) {
  if (page.next_cursor) reply.header("x-next-cursor", page.next_cursor);
  return page.items;
}
