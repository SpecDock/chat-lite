export class ArtifactStore {
  private readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): T {
    this.values.set(key, value);
    return value;
  }

  has(key: string) {
    return this.values.has(key);
  }

  appendText(key: string, text: string) {
    const next = `${String(this.values.get(key) || '')}${text}`;
    this.values.set(key, next);
    return next;
  }

  entries() {
    return Object.fromEntries(this.values.entries());
  }
}
