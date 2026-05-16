export interface Signal<T> {
  value: T;
}

export function signal<T>(value: T): Signal<T> {
  return { value };
}

export function batch<T>(fn: () => T): T {
  return fn();
}
