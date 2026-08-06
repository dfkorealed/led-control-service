export const dirtyEditorSentinelKey = "__floorEditorDirtySentinel";

export function hasDirtyEditorSentinel(token?: string) {
  const sentinelToken = window.history.state?.[dirtyEditorSentinelKey];
  return token ? sentinelToken === token : typeof sentinelToken === "string";
}
