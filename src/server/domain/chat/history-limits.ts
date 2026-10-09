function intEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function answerHistoryLimit() {
  return intEnv('ANSWER_HISTORY_LIMIT', 6);
}
