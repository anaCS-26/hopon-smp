export const ALLOWED: Array<[string, RegExp]>;
export function toAgentPath(method: string, segments: string[], search: URLSearchParams): string | null;
export function csrfOk(r: {
  method: string;
  origin: string | null;
  host: string | null;
  csrfHeader: string | null;
  sessionCsrf: string;
  expectedOrigin?: string;
}): boolean;
