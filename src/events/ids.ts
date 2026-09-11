import { randomUUID } from 'node:crypto';

export function newEventId(): string {
  return randomUUID();
}
