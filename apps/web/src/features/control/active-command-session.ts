const generationByUser = new Map<string, number>();
const controllersByUser = new Map<string, Set<AbortController>>();
const blockedUsers = new Set<string>();

export function registerActiveCommandRequest(userId: string, controller: AbortController) {
  if (isActiveCommandSessionBlocked(userId)) {
    controller.abort();
    return null;
  }

  const generation = currentActiveCommandGeneration(userId);
  const controllers = controllersByUser.get(userId) ?? new Set<AbortController>();
  controllers.add(controller);
  controllersByUser.set(userId, controllers);

  const release = () => {
    controllers.delete(controller);
    if (controllers.size === 0) controllersByUser.delete(userId);
  };
  controller.signal.addEventListener("abort", release, { once: true });

  return {
    generation,
    release: () => {
      controller.signal.removeEventListener("abort", release);
      release();
    }
  };
}

export function blockActiveCommandSession(userId: string): void {
  blockedUsers.add(userId);
  invalidateActiveCommandSession(userId);
}

export function unblockActiveCommandSession(userId: string): void {
  blockedUsers.delete(userId);
}

export function isActiveCommandSessionBlocked(userId: string): boolean {
  return blockedUsers.has(userId);
}

export function invalidateActiveCommandSession(userId: string): void {
  generationByUser.set(userId, currentActiveCommandGeneration(userId) + 1);
  const controllers = controllersByUser.get(userId);
  if (!controllers) return;

  [...controllers].forEach((controller) => controller.abort());
  controllersByUser.delete(userId);
}

export function ownsActiveCommandSession(userId: string, generation: number): boolean {
  return currentActiveCommandGeneration(userId) === generation;
}

function currentActiveCommandGeneration(userId: string): number {
  return generationByUser.get(userId) ?? 0;
}
