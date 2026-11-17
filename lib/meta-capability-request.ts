export function createReplaceableRequestController() {
  let current: AbortController | null = null;
  return {
    begin() {
      current?.abort();
      current = new AbortController();
      return current;
    },
    finish(controller: AbortController) {
      if (current === controller) current = null;
    },
    abort() {
      current?.abort();
      current = null;
    },
  };
}
